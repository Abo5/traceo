// Package execution — Execution Engine (TRD §4.6): runs approved test cases
// against a project environment. 1:1 port of backend/app/modules/execution.py.
//
// Auth resolved ONCE per run (FR-EXE-04), variable interpolation + response
// chaining (FR-EXE-05), failed vs errored distinction (FR-EXE-11), redacted
// evidence capture (NFR-SEC-03), partial results streamed to the DB as each case
// finishes, best-effort cancel (FR-EXE-10).
//
// Routes use `:id` for run ids (NOT `:run_id`) — the integrations module already
// registered /runs/:id/exports/*, and gin panics on conflicting wildcard names.
//
// Webhooks: on a terminal run state this package calls
// integrations.FireWebhooks. The import is one-way (integrations never imports
// execution — it reaches back through the ExecuteRun / LaunchRunForSchedule
// function hooks wired in init below), so there is no cycle.
package execution

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gin-gonic/gin"

	"traceo/internal/config"
	"traceo/internal/db"
	"traceo/internal/httpx"
	"traceo/internal/jobs"
	"traceo/internal/models"
	"traceo/internal/modules/integrations"
	"traceo/internal/security"
)

const runDisplayBase = 1000 // first run of a project renders as #1001

// Best-effort cancellation flags (FR-EXE-10): run_id -> true. Checked between cases.
var (
	cancelMu    sync.Mutex
	cancelFlags = map[string]bool{}

	// dbWriteMu serialises result writes — sqlite is single-writer, and the
	// Python reference holds the same lock around each per-case commit.
	dbWriteMu sync.Mutex
)

func setCancel(runID string) {
	cancelMu.Lock()
	cancelFlags[runID] = true
	cancelMu.Unlock()
}

func isCancelled(runID string) bool {
	cancelMu.Lock()
	defer cancelMu.Unlock()
	return cancelFlags[runID]
}

func popCancel(runID string) bool {
	cancelMu.Lock()
	defer cancelMu.Unlock()
	v := cancelFlags[runID]
	delete(cancelFlags, runID)
	return v
}

func utcnow() time.Time { return time.Now().UTC() }

func iso(t *time.Time) any {
	if t == nil {
		return nil
	}
	return t.UTC().Format(time.RFC3339)
}

func isoV(t time.Time) string { return t.UTC().Format(time.RFC3339) }

// init wires the reverse-direction hooks integrations exposes for run execution
// (see the package comment on integrations). Assignment is idempotent, so an
// explicit wiring in cmd/server/main.go remains harmless.
func init() {
	integrations.ExecuteRun = ExecuteRun
	integrations.LaunchRunForSchedule = LaunchRunForSchedule
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

func Register(r *gin.RouterGroup) {
	// Run launch and the single-run read are part of the public CI surface, so they
	// also accept `X-API-Key` (API_CONTRACT_V2_ADDENDUM.md). Without that header
	// AuthOrAPIKey is exactly Auth, so JWT callers are unaffected. The remaining
	// routes stay JWT-only.
	r.POST("/projects/:project_id/runs", httpx.AuthOrAPIKey(), httpx.Require("trigger_run"), createRun)
	r.GET("/runs/:id", httpx.AuthOrAPIKey(), httpx.Require("view"), getRun)

	g := r.Group("", httpx.Auth())
	g.GET("/projects/:project_id/runs", httpx.Require("view"), listRuns)
	g.GET("/runs/:id/results", httpx.Require("view"), getRunResults)
	g.POST("/runs/:id/cancel", httpx.Require("trigger_run"), cancelRun)
}

// ---------------------------------------------------------------------------
// Auth — once per run (FR-EXE-04). Token kept in memory only.
// ---------------------------------------------------------------------------

// authSetupError: auth could not be established — the run aborts with a single
// diagnostic and NO per-case failures.
type authSetupError struct{ msg string }

func (e *authSetupError) Error() string { return e.msg }

type basicCreds struct{ user, pass string }

type authBundle struct {
	headers map[string]string
	params  map[string]string
	basic   *basicCreds
	token   string
}

func httpTransport(tlsStrict bool) *http.Transport {
	tr := &http.Transport{Proxy: http.ProxyFromEnvironment}
	if !tlsStrict {
		tr.TLSClientConfig = &tls.Config{InsecureSkipVerify: true} // #nosec G402 — user opted out
	}
	return tr
}

// newRunClient mirrors httpx.Client defaults: redirects are NOT followed.
func newRunClient(tlsStrict bool) *http.Client {
	return &http.Client{
		Transport:     httpTransport(tlsStrict),
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
}

func buildAuth(authType string, cfg map[string]any, tlsStrict bool) (*authBundle, error) {
	b := &authBundle{headers: map[string]string{}, params: map[string]string{}}
	if authType == "" {
		authType = "none"
	}
	if authType == "none" {
		return b, nil
	}
	if len(cfg) == 0 {
		return nil, &authSetupError{fmt.Sprintf(
			"auth configuration for type '%s' is missing or could not be decrypted", authType)}
	}

	switch authType {
	case "api_key":
		key := mapStr(cfg, "key")
		if key == "" {
			key = mapStr(cfg, "api_key")
		}
		if key == "" {
			key = mapStr(cfg, "value")
		}
		if key == "" {
			return nil, &authSetupError{"api_key auth is configured without a key"}
		}
		location := mapStr(cfg, "in")
		if location == "" {
			location = mapStr(cfg, "location")
		}
		if location == "" {
			location = "header"
		}
		if location == "query" {
			param := mapStr(cfg, "param")
			if param == "" {
				param = mapStr(cfg, "name")
			}
			if param == "" {
				param = "api_key"
			}
			b.params[param] = key
		} else {
			header := mapStr(cfg, "header")
			if header == "" {
				header = "X-API-Key"
			}
			b.headers[header] = key
		}

	case "basic":
		b.basic = &basicCreds{user: mapStr(cfg, "username"), pass: mapStr(cfg, "password")}

	case "bearer":
		tok := mapStr(cfg, "token")
		if tok == "" {
			tok = mapStr(cfg, "key")
		}
		if tok == "" {
			return nil, &authSetupError{"bearer auth is configured without a token"}
		}
		b.headers["Authorization"] = "Bearer " + tok

	case "oauth2_cc":
		tokenURL := mapStr(cfg, "token_url")
		if tokenURL == "" {
			return nil, &authSetupError{"oauth2_cc auth is configured without a token_url"}
		}
		form := url.Values{
			"grant_type":    {"client_credentials"},
			"client_id":     {mapStr(cfg, "client_id")},
			"client_secret": {mapStr(cfg, "client_secret")},
		}
		client := &http.Client{
			Transport: httpTransport(tlsStrict),
			Timeout:   time.Duration(config.C.ReqTimeoutS * float64(time.Second)),
		}
		resp, err := client.PostForm(tokenURL, form)
		if err != nil {
			// diagnostic must not leak secrets — exception class only
			return nil, &authSetupError{"oauth2 token request failed: " + errClass(err)}
		}
		defer resp.Body.Close()
		if resp.StatusCode >= 400 {
			return nil, &authSetupError{fmt.Sprintf(
				"oauth2 token endpoint returned HTTP %d", resp.StatusCode)}
		}
		var payload map[string]any
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		_ = json.Unmarshal(raw, &payload)
		token, _ := payload["access_token"].(string)
		if token == "" {
			return nil, &authSetupError{"oauth2 token response did not contain access_token"}
		}
		b.token = token
		b.headers["Authorization"] = "Bearer " + token

	default:
		return nil, &authSetupError{fmt.Sprintf("unsupported auth_type '%s'", authType)}
	}
	return b, nil
}

// errClass approximates Python's `type(e).__name__` for transport failures —
// enough to distinguish a timeout from any other transport problem without
// echoing URLs or credentials into the diagnostic.
func errClass(err error) string {
	if err == nil {
		return "Error"
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "TimeoutException"
	}
	var ne interface{ Timeout() bool }
	if errors.As(err, &ne) && ne.Timeout() {
		return "TimeoutException"
	}
	return "TransportError"
}

// ---------------------------------------------------------------------------
// Case snapshots (workers must not share ORM state)
// ---------------------------------------------------------------------------

type stepSnapshot struct {
	Order       int
	EndpointID  string
	Method      string
	Path        string
	Request     map[string]any
	Assertions  []any
	Extractions []any
}

type caseSnapshot struct {
	ID      string
	Version int
	Steps   []stepSnapshot
}

var errRunTimeout = errors.New("run timeout")

// ---------------------------------------------------------------------------
// Per-case execution (runs on a pool goroutine; writes its own result)
// ---------------------------------------------------------------------------

type workerCtx struct {
	runID           string
	client          *http.Client
	baseURL         string
	auth            *authBundle
	envVars         map[string]any
	endpointSchemas map[string]models.JSONMap
	deadline        time.Time
	secrets         []string
}

func caseWorker(w *workerCtx, cse caseSnapshot) string {
	if isCancelled(w.runID) {
		return "skipped"
	}

	started := time.Now()
	ctxVars := make(map[string]any, len(w.envVars))
	for k, v := range w.envVars {
		ctxVars[k] = v
	}
	evidence := []any{}
	outcome := "passed"
	var failureReason map[string]any
	stepIndex := -1

	fatal := func(err error) {
		idx := stepIndex
		if idx < 0 {
			idx = 0
		}
		outcome = "errored"
		if errors.Is(err, errRunTimeout) {
			failureReason = map[string]any{"error": "run timeout", "step_index": idx}
			return
		}
		failureReason = map[string]any{
			"error":      security.Redact(errClass(err)+": "+err.Error(), w.secrets),
			"step_index": idx,
		}
	}

steps:
	for i, step := range cse.Steps {
		stepIndex = i
		remaining := time.Until(w.deadline)
		if remaining <= 0 {
			fatal(errRunTimeout)
			break
		}

		req := step.Request
		if req == nil {
			req = map[string]any{}
		}
		rawHeaders := asMap(req["headers"])
		if rawHeaders == nil {
			rawHeaders = map[string]any{}
		}
		// Unauthenticated-negative support: an explicitly empty Authorization
		// header means "send this request without any credentials".
		stripAuth := false
		if v, ok := rawHeaders["Authorization"]; ok {
			if s, isStr := v.(string); isStr && s == "" {
				stripAuth = true
			}
		}

		method := strings.ToUpper(step.Method)
		if method == "" {
			method = "GET"
		}
		pathRaw := step.Path
		if pathRaw == "" {
			pathRaw = "/"
		}
		path := pyStr(interpolate(pathRaw, ctxVars))

		stepParams := asMap(interpolate(asMapOrEmpty(req["params"]), ctxVars))
		stepHeaders := asMap(interpolate(rawHeaders, ctxVars))

		headers := map[string]string{}
		if !stripAuth {
			for k, v := range w.auth.headers {
				headers[k] = v
			}
		}
		for k, v := range stepHeaders {
			if stripAuth && k == "Authorization" {
				continue
			}
			if v == nil {
				delete(headers, k)
				continue
			}
			if s, isStr := v.(string); isStr && s == "" {
				delete(headers, k)
				continue
			}
			headers[k] = pyStr(v)
		}
		if stripAuth {
			delete(headers, "Authorization")
		}

		params := map[string]string{}
		if !stripAuth {
			for k, v := range w.auth.params {
				params[k] = v
			}
		}
		for k, v := range stepParams {
			params[k] = paramStr(v)
		}

		var bodyBytes []byte
		var bodyRepr any
		hasBody := false
		jsonBody := false
		if rb, ok := req["raw_body"].(string); ok && strings.Contains(rb, "{{malformed}}") {
			// FR-GEN-08 malformed-body negative: intentionally broken JSON payload
			bodyBytes = []byte("not-json{{{")
			hasBody = true
			bodyRepr = "not-json{{{"
			if _, present := headers["Content-Type"]; !present {
				headers["Content-Type"] = "application/json"
			}
		} else if rbv, ok := req["raw_body"]; ok && rbv != nil {
			content := pyStr(interpolate(rbv, ctxVars))
			bodyBytes = []byte(content)
			hasBody = true
			bodyRepr = content
		} else if bv, ok := req["body"]; ok && bv != nil {
			body := interpolate(bv, ctxVars)
			enc, err := json.Marshal(body)
			if err != nil {
				enc = []byte(pyStr(body))
			}
			bodyBytes = enc
			hasBody = true
			jsonBody = true // Content-Type added by the transport, after evidence capture
			bodyRepr = string(enc)
		}

		evHeaders := map[string]string{}
		for k, v := range headers {
			evHeaders[k] = security.Redact(v, w.secrets)
		}
		var evBody any
		if bodyRepr != nil {
			if s, _ := bodyRepr.(string); s != "" {
				evBody = truncate(security.Redact(s, w.secrets))
			} else {
				evBody = bodyRepr
			}
		}
		fullURL := strings.TrimRight(w.baseURL, "/") + path
		reqEvidence := map[string]any{
			"method":  method,
			"url":     security.Redact(fullURL, w.secrets),
			"headers": evHeaders,
			"body":    evBody,
		}

		timeout := math.Min(config.C.ReqTimeoutS, remaining.Seconds())
		if timeout < 0.001 {
			timeout = 0.001
		}
		reqCtx, cancel := context.WithTimeout(context.Background(),
			time.Duration(timeout*float64(time.Second)))

		var reader io.Reader
		if hasBody {
			reader = bytes.NewReader(bodyBytes)
		}
		httpReq, err := http.NewRequestWithContext(reqCtx, method, fullURL, reader)
		if err != nil {
			cancel()
			msg := security.Redact("InvalidURL: "+err.Error(), w.secrets)
			evidence = append(evidence, map[string]any{"request": reqEvidence, "response": nil,
				"elapsed_ms": 0, "assertions": []any{}, "error": msg})
			outcome = "errored"
			failureReason = map[string]any{"error": msg, "step_index": i}
			break
		}
		if len(params) > 0 { // httpx: `params=` replaces the query string entirely
			q := url.Values{}
			for k, v := range params {
				q.Set(k, v)
			}
			httpReq.URL.RawQuery = q.Encode()
		}
		for k, v := range headers {
			httpReq.Header.Set(k, v)
		}
		if jsonBody && httpReq.Header.Get("Content-Type") == "" {
			httpReq.Header.Set("Content-Type", "application/json")
		}
		if w.auth.basic != nil && !stripAuth {
			httpReq.SetBasicAuth(w.auth.basic.user, w.auth.basic.pass)
		}

		t0 := time.Now()
		resp, err := w.client.Do(httpReq)
		if err != nil {
			cancel()
			elapsed := int(time.Since(t0).Milliseconds())
			msg := security.Redact(errClass(err)+": "+err.Error(), w.secrets)
			evidence = append(evidence, map[string]any{"request": reqEvidence, "response": nil,
				"elapsed_ms": elapsed, "assertions": []any{}, "error": msg})
			outcome = "errored"
			failureReason = map[string]any{"error": msg, "step_index": i}
			break
		}
		rawBody, readErr := io.ReadAll(resp.Body)
		resp.Body.Close()
		cancel()
		elapsedMs := int(time.Since(t0).Milliseconds())

		reqEvidence["url"] = security.Redact(httpReq.URL.String(), w.secrets)
		respText := string(rawBody)
		if readErr != nil {
			respText = "<undecodable body>"
		}
		var respJSON any
		dec := json.NewDecoder(bytes.NewReader(rawBody))
		dec.UseNumber() // keep integers exact, as Python's json.loads does
		if e := dec.Decode(&respJSON); e != nil {
			respJSON = nil
		}

		view := &respView{StatusCode: resp.StatusCode, Header: resp.Header}
		var schemas map[string]any
		if step.EndpointID != "" {
			if s, ok := w.endpointSchemas[step.EndpointID]; ok {
				schemas = s
			}
		}

		assertionRecords := []any{}
		var failedAssertion map[string]any
		var failedActual any
		for _, av := range step.Assertions {
			a := asMap(av)
			if a == nil {
				continue
			}
			ok, actual, skipped := evalAssertion(a, view, respJSON, elapsedMs, schemas)
			state := "passed"
			if skipped {
				state = "skipped"
			} else if !ok {
				state = "failed"
			}
			assertionRecords = append(assertionRecords,
				map[string]any{"assertion": a, "outcome": state, "actual": actual})
			if !ok && !skipped {
				failedAssertion, failedActual = a, actual
				break // halt at first failed assertion (FR-EXE-11)
			}
		}

		evidence = append(evidence, map[string]any{
			"request": reqEvidence,
			"response": map[string]any{
				"status":  resp.StatusCode,
				"headers": evidenceHeaders(resp.Header),
				"body":    truncate(security.Redact(respText, w.secrets)),
			},
			"elapsed_ms": elapsedMs,
			"assertions": assertionRecords,
		})

		if failedAssertion != nil {
			outcome = "failed"
			expected, present := failedAssertion["expected"]
			if !present {
				expected, present = failedAssertion["expected_any"]
			}
			if !present {
				expected = failedAssertion["max"]
			}
			failureReason = map[string]any{
				"assertion":  failedAssertion,
				"expected":   expected,
				"actual":     failedActual,
				"step_index": i,
			}
			break steps
		}

		// Chaining (FR-EXE-05): pull values from the response into context
		for _, ev := range step.Extractions {
			ex := asMap(ev)
			if ex == nil {
				continue
			}
			name, _ := ex["name"].(string)
			if name == "" {
				continue
			}
			path, _ := ex["path"].(string)
			if v, e := resolvePath(respJSON, path); e == nil {
				ctxVars[name] = v
			} // leave placeholder unresolved otherwise
		}
	}

	durationMs := int(time.Since(started).Milliseconds())

	// Immutable result, committed as the case finishes (partial visibility)
	res := models.TestResult{
		RunID: w.runID, TestCaseID: cse.ID, TestCaseVersion: cse.Version,
		Outcome: outcome, DurationMs: durationMs, Evidence: models.JSONList(evidence),
	}
	if failureReason != nil {
		res.FailureReason = models.JSONMap(failureReason)
	}
	dbWriteMu.Lock()
	db.DB.Create(&res)
	dbWriteMu.Unlock()
	return outcome
}

func asMapOrEmpty(v any) map[string]any {
	if m := asMap(v); m != nil {
		return m
	}
	return map[string]any{}
}

// paramStr renders a query-parameter value the way httpx does (lowercase bools).
func paramStr(v any) string {
	if b, ok := v.(bool); ok {
		if b {
			return "true"
		}
		return "false"
	}
	return pyStr(v)
}

var evidenceHeaderKeys = []string{"content-type", "content-length", "server", "date", "x-request-id"}

func evidenceHeaders(h http.Header) map[string]string {
	out := map[string]string{}
	for _, k := range evidenceHeaderKeys {
		if vals := h.Values(k); len(vals) > 0 {
			out[k] = strings.Join(vals, ", ")
		}
	}
	return out
}

// ---------------------------------------------------------------------------
// Run job
// ---------------------------------------------------------------------------

// ExecuteRun executes a queued run end to end. Submitted via jobs.Submit by the
// launch endpoints and by the integrations scheduler (through its hook).
func ExecuteRun(j *jobs.Job, runID string, caseIDs []string) (result any, err error) {
	defer func() {
		if rec := recover(); rec != nil {
			// never leave a run stuck in 'running'
			var run models.Run
			if e := db.DB.First(&run, "id = ?", runID).Error; e == nil &&
				(run.State == "queued" || run.State == "running") {
				now := utcnow()
				db.DB.Model(&models.Run{}).Where("id = ?", runID).Updates(map[string]any{
					"state":        "aborted",
					"abort_reason": fmt.Sprintf("internal error: %v", rec),
					"finished_at":  now,
				})
			}
			popCancel(runID)
			result, err = nil, fmt.Errorf("execution panic: %v", rec)
		}
	}()

	var run models.Run
	if e := db.DB.First(&run, "id = ?", runID).Error; e != nil {
		return gin.H{"run_id": runID, "state": "missing"}, nil
	}
	var env models.Environment
	hasEnv := db.DB.First(&env, "id = ?", run.EnvironmentID).Error == nil

	startedAt := utcnow()
	db.DB.Model(&models.Run{}).Where("id = ?", runID).
		Updates(map[string]any{"state": "running", "started_at": startedAt})

	if !hasEnv {
		// The Python reference dereferences env unconditionally; a missing
		// environment therefore surfaces as an aborted run, not a stuck one.
		return abortRun(runID, "environment not found"), nil
	}

	cfg := security.Decrypt(env.AuthConfigEncrypted)
	secrets := collectSecrets(cfg)
	auth, authErr := buildAuth(env.AuthType, cfg, env.TLSStrict)
	if authErr != nil {
		// FR-EXE-04: single diagnostic, NO per-case failures
		reason := security.Redact(authErr.Error(), secrets)
		finished := utcnow()
		db.DB.Model(&models.Run{}).Where("id = ?", runID).Updates(map[string]any{
			"state": "aborted", "abort_reason": reason, "finished_at": finished,
			"counts": models.JSONMap{"total": 0, "passed": 0, "failed": 0, "errored": 0},
		})
		popCancel(runID)
		return gin.H{"run_id": runID, "state": "aborted", "reason": reason}, nil
	}
	if auth.token != "" {
		secrets = append(secrets, auth.token) // in memory only, never persisted
	}

	// Snapshot cases/steps into plain values
	cases := make([]caseSnapshot, 0, len(caseIDs))
	for _, cid := range caseIDs {
		var tc models.TestCase
		if e := db.DB.First(&tc, "id = ?", cid).Error; e != nil {
			continue
		}
		var steps []models.TestStep
		db.DB.Where("test_case_id = ?", tc.ID).Order("step_order ASC").Find(&steps)
		snap := caseSnapshot{ID: tc.ID, Version: tc.Version,
			Steps: make([]stepSnapshot, 0, len(steps))}
		for _, s := range steps {
			epID := ""
			if s.EndpointID != nil {
				epID = *s.EndpointID
			}
			snap.Steps = append(snap.Steps, stepSnapshot{
				Order: s.Order, EndpointID: epID, Method: s.Method, Path: s.Path,
				Request: map[string]any(s.Request), Assertions: []any(s.Assertions),
				Extractions: []any(s.Extractions),
			})
		}
		cases = append(cases, snap)
	}

	epIDSet := map[string]bool{}
	for _, cse := range cases {
		for _, s := range cse.Steps {
			if s.EndpointID != "" {
				epIDSet[s.EndpointID] = true
			}
		}
	}
	endpointSchemas := map[string]models.JSONMap{}
	if len(epIDSet) > 0 {
		ids := make([]string, 0, len(epIDSet))
		for id := range epIDSet {
			ids = append(ids, id)
		}
		var eps []models.Endpoint
		db.DB.Where("id IN ?", ids).Find(&eps)
		for _, ep := range eps {
			schemas := ep.ResponseSchemas
			if schemas == nil {
				schemas = models.JSONMap{}
			}
			endpointSchemas[ep.ID] = schemas
		}
	}

	envVars := map[string]any{}
	for k, v := range env.Variables {
		envVars[k] = v
	}

	total := len(cases)
	w := &workerCtx{
		runID: runID, client: newRunClient(env.TLSStrict), baseURL: env.BaseURL,
		auth: auth, envVars: envVars, endpointSchemas: endpointSchemas,
		deadline: time.Now().Add(time.Duration(config.C.RunTimeoutS * float64(time.Second))),
		secrets:  secrets,
	}

	concurrency := config.C.RunConc
	if concurrency < 1 {
		concurrency = 1
	}
	sem := make(chan struct{}, concurrency)
	var wg sync.WaitGroup
	var done int64
	for _, cse := range cases {
		wg.Add(1)
		go func(cse caseSnapshot) {
			defer wg.Done()
			defer func() {
				n := atomic.AddInt64(&done, 1)
				if j != nil {
					if total > 0 {
						j.Set(float64(n)/float64(total), "")
					} else {
						j.Set(1, "")
					}
				}
			}()
			defer func() { _ = recover() }() // workers never propagate a panic
			sem <- struct{}{}
			defer func() { <-sem }()
			caseWorker(w, cse)
		}(cse)
	}
	wg.Wait()
	w.client.CloseIdleConnections()

	cancelled := popCancel(runID)

	var results []models.TestResult
	db.DB.Where("run_id = ?", runID).Find(&results)
	counts := models.JSONMap{"total": len(results), "passed": 0, "failed": 0, "errored": 0}
	for _, r := range results {
		if v, ok := counts[r.Outcome].(int); ok {
			counts[r.Outcome] = v + 1
		} else {
			counts[r.Outcome] = 1
		}
	}
	state := "completed"
	if cancelled {
		state = "cancelled"
	}
	finished := utcnow()
	db.DB.Model(&models.Run{}).Where("id = ?", runID).Updates(map[string]any{
		"counts": counts, "state": state, "finished_at": finished,
	})

	// v2 addendum: notify project webhooks after the terminal state — a webhook
	// failure must never break a run.
	func() {
		defer func() { _ = recover() }()
		var fresh models.Run
		if e := db.DB.First(&fresh, "id = ?", runID).Error; e != nil {
			return
		}
		var project models.Project
		projectName := ""
		if e := db.DB.First(&project, "id = ?", fresh.ProjectID).Error; e == nil {
			projectName = project.Name
		}
		totalN, _ := counts["total"].(int)
		passedN, _ := counts["passed"].(int)
		var coverage any
		if totalN > 0 {
			coverage = math.Round(float64(passedN)/float64(totalN)*100*10) / 10
		}
		integrations.FireWebhooks(fresh.ProjectID, "run.completed", map[string]any{
			"event":   "run.completed",
			"project": map[string]any{"id": fresh.ProjectID, "name": projectName},
			"run": map[string]any{"id": fresh.ID, "display_id": runDisplayID(&fresh),
				"state": state, "counts": map[string]any(counts), "coverage_pct": coverage},
			"timestamp": isoV(utcnow()),
		})
	}()

	return gin.H{"run_id": runID, "state": state, "counts": counts}, nil
}

func abortRun(runID, reason string) gin.H {
	finished := utcnow()
	db.DB.Model(&models.Run{}).Where("id = ?", runID).Updates(map[string]any{
		"state": "aborted", "abort_reason": reason, "finished_at": finished,
		"counts": models.JSONMap{"total": 0, "passed": 0, "failed": 0, "errored": 0},
	})
	popCancel(runID)
	return gin.H{"run_id": runID, "state": "aborted", "reason": reason}
}

// LaunchRunForSchedule creates and executes a run for a due schedule (all
// approved cases, the schedule's environment). Port of the second half of the
// Python integrations._launch_scheduled_run — the schedule's own last_run_at /
// next_run_at bookkeeping is done by the caller. Returns an error when the
// launch is skipped, so the scheduler does not count it.
func LaunchRunForSchedule(projectID, envID, userID string) error {
	var project models.Project
	if err := db.DB.First(&project, "id = ?", projectID).Error; err != nil {
		return errors.New("project not found")
	}
	orgID := project.OrganisationID

	var env models.Environment
	if err := db.DB.First(&env, "id = ? AND project_id = ?", envID, projectID).Error; err != nil {
		return errors.New("environment not found")
	}
	var cases []models.TestCase
	db.DB.Where("project_id = ? AND organisation_id = ? AND state = ?",
		projectID, orgID, "approved").Find(&cases)
	if len(cases) == 0 {
		return errors.New("no approved cases") // skip silently
	}

	run := models.Run{OrganisationID: orgID, ProjectID: projectID, EnvironmentID: env.ID,
		State: "queued", InitiatedBy: userID, Counts: models.JSONMap{}}
	if err := db.DB.Create(&run).Error; err != nil {
		return err
	}
	actor := userID
	var actorPtr *string
	if actor != "" {
		actorPtr = &actor
	}
	httpx.Audit(orgID, actorPtr, "run.scheduled", "run", run.ID,
		models.JSONMap{"environment_id": env.ID, "case_count": len(cases)})

	runID := run.ID
	caseIDs := make([]string, len(cases))
	for i, cse := range cases {
		caseIDs[i] = cse.ID
	}
	jobs.Submit("execute", func(j *jobs.Job) (any, error) { return ExecuteRun(j, runID, caseIDs) })
	return nil
}

// ---------------------------------------------------------------------------
// display ids
// ---------------------------------------------------------------------------

// runDisplayIDs: run_id -> chronological #1001-style display id in the project.
func runDisplayIDs(projectID string) map[string]int {
	var ids []string
	db.DB.Model(&models.Run{}).Where("project_id = ?", projectID).
		Order("created_at ASC, id ASC").Pluck("id", &ids)
	out := make(map[string]int, len(ids))
	for i, id := range ids {
		out[id] = runDisplayBase + i + 1
	}
	return out
}

func runDisplayID(run *models.Run) int {
	if n, ok := runDisplayIDs(run.ProjectID)[run.ID]; ok {
		return n
	}
	return runDisplayBase + 1
}

// ---------------------------------------------------------------------------
// HTTP handlers
// ---------------------------------------------------------------------------

func runDict(run *models.Run) gin.H {
	counts := run.Counts
	if counts == nil {
		counts = models.JSONMap{}
	}
	var abort any
	if run.AbortReason != "" {
		abort = run.AbortReason
	}
	return gin.H{
		"id": run.ID, "project_id": run.ProjectID, "environment_id": run.EnvironmentID,
		"state": run.State, "started_at": iso(run.StartedAt),
		"finished_at": iso(run.FinishedAt), "counts": counts,
		"initiated_by": run.InitiatedBy, "abort_reason": abort,
		"created_at": isoV(run.CreatedAt),
	}
}

// runScoped loads a run only within the caller's organisation (NFR-SEC-04).
func runScoped(c *gin.Context) (*models.Run, bool) {
	u := httpx.User(c)
	var run models.Run
	if err := db.DB.First(&run, "id = ? AND organisation_id = ?",
		c.Param("id"), u.OrganisationID).Error; err != nil {
		httpx.Err(c, http.StatusNotFound, "not_found", "Run not found")
		return nil, false
	}
	return &run, true
}

func createRun(c *gin.Context) {
	u := httpx.User(c)
	projectID := c.Param("project_id")
	var body struct {
		EnvironmentID string   `json:"environment_id"`
		TestCaseIDs   []string `json:"test_case_ids"`
	}
	if err := c.ShouldBindJSON(&body); err != nil || body.EnvironmentID == "" {
		httpx.Err(c, http.StatusUnprocessableEntity, "invalid_body",
			"environment_id is required")
		return
	}
	if _, ok := httpx.ProjectScoped(c, projectID); !ok {
		return
	}
	var env models.Environment
	if err := db.DB.First(&env, "id = ? AND project_id = ? AND organisation_id = ?",
		body.EnvironmentID, projectID, u.OrganisationID).Error; err != nil {
		httpx.Err(c, http.StatusNotFound, "not_found",
			"Environment not found in this project")
		return
	}

	q := db.DB.Where("project_id = ? AND organisation_id = ? AND state = ?",
		projectID, u.OrganisationID, "approved")
	if len(body.TestCaseIDs) > 0 {
		q = q.Where("id IN ?", body.TestCaseIDs)
	}
	var cases []models.TestCase
	q.Find(&cases)
	if len(cases) == 0 {
		httpx.Err(c, http.StatusConflict, "no_approved_cases",
			"No approved test cases to execute")
		return
	}

	run := models.Run{OrganisationID: u.OrganisationID, ProjectID: projectID,
		EnvironmentID: env.ID, State: "queued", InitiatedBy: u.ID,
		Counts: models.JSONMap{}}
	if err := db.DB.Create(&run).Error; err != nil {
		httpx.Err(c, http.StatusInternalServerError, "internal_error", "Could not create run")
		return
	}
	httpx.Audit(u.OrganisationID, &u.ID, "run.started", "run", run.ID,
		models.JSONMap{"environment_id": env.ID, "case_count": len(cases)})

	runID := run.ID
	caseIDs := make([]string, len(cases))
	for i, cse := range cases {
		caseIDs[i] = cse.ID
	}
	job := jobs.Submit("execute", func(j *jobs.Job) (any, error) {
		return ExecuteRun(j, runID, caseIDs)
	})
	c.JSON(http.StatusAccepted, gin.H{"job_id": job.ID, "run_id": runID})
}

func listRuns(c *gin.Context) {
	u := httpx.User(c)
	projectID := c.Param("project_id")
	if _, ok := httpx.ProjectScoped(c, projectID); !ok {
		return
	}
	var runs []models.Run
	db.DB.Where("project_id = ? AND organisation_id = ?", projectID, u.OrganisationID).
		Order("created_at DESC").Find(&runs)
	displayIDs := runDisplayIDs(projectID)
	payload := make([]gin.H, 0, len(runs))
	for i := range runs {
		d := runDict(&runs[i])
		var did any
		if v, ok := displayIDs[runs[i].ID]; ok {
			did = v
		}
		d["display_id"] = did
		payload = append(payload, d)
	}
	c.JSON(http.StatusOK, gin.H{"runs": payload})
}

func getRun(c *gin.Context) {
	run, ok := runScoped(c)
	if !ok {
		return
	}
	d := runDict(run)
	d["display_id"] = runDisplayID(run)
	c.JSON(http.StatusOK, d)
}

func getRunResults(c *gin.Context) {
	run, ok := runScoped(c)
	if !ok {
		return
	}
	var results []models.TestResult
	q := db.DB.Where("run_id = ?", run.ID)
	if outcome := c.Query("outcome"); outcome != "" {
		q = q.Where("outcome = ?", outcome)
	}
	q.Order("created_at ASC").Find(&results)

	caseIDs := make([]string, 0, len(results))
	seen := map[string]bool{}
	for _, r := range results {
		if !seen[r.TestCaseID] {
			seen[r.TestCaseID] = true
			caseIDs = append(caseIDs, r.TestCaseID)
		}
	}
	byID := map[string]*models.TestCase{}
	if len(caseIDs) > 0 {
		var cases []models.TestCase
		db.DB.Where("id IN ?", caseIDs).Find(&cases)
		for i := range cases {
			byID[cases[i].ID] = &cases[i]
		}
	}

	out := []gin.H{}
	for i := range results {
		res := &results[i]
		tc := byID[res.TestCaseID]
		if tc == nil {
			continue // inner join in the reference query
		}
		var failure any
		if len(res.FailureReason) > 0 {
			failure = res.FailureReason
		}
		evidence := res.Evidence
		if evidence == nil {
			evidence = models.JSONList{}
		}
		out = append(out, gin.H{
			"id": res.ID,
			"test_case": gin.H{"id": tc.ID, "title": tc.Title, "type": tc.Type,
				"priority": tc.Priority, "state": tc.State},
			"test_case_version": res.TestCaseVersion,
			"outcome":           res.Outcome,
			"duration_ms":       res.DurationMs,
			"failure_reason":    failure,
			"evidence":          evidence,
			"created_at":        isoV(res.CreatedAt),
		})
	}
	c.JSON(http.StatusOK, gin.H{"run_id": run.ID, "results": out})
}

func cancelRun(c *gin.Context) {
	u := httpx.User(c)
	run, ok := runScoped(c)
	if !ok {
		return
	}
	if run.State != "queued" && run.State != "running" {
		httpx.Err(c, http.StatusConflict, "not_cancellable",
			"Run is already "+run.State)
		return
	}
	setCancel(run.ID) // best-effort (FR-EXE-10); partial results kept
	httpx.Audit(u.OrganisationID, &u.ID, "run.cancel_requested", "run", run.ID, nil)
	c.JSON(http.StatusOK, gin.H{"run_id": run.ID, "state": run.State,
		"cancel_requested": true})
}

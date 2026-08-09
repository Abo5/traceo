// Package discovery — OpenAPI/Swagger Discovery Engine (TRD §4.2) — fully
// deterministic, NO LLM.
//
// Imports an OpenAPI 3.x or Swagger 2.0 specification (multipart file or URL),
// resolves internal $refs cycle-safely, and flattens every operation into an Endpoint
// inventory row. Broken/unresolvable operations are recorded as warnings and skipped,
// never fatal (FR-DSC-04). URL fetches are SSRF-guarded. Re-import bumps the spec
// version and REPLACES the endpoint inventory, returning an added/removed/changed
// diff. Port of backend/app/modules/discovery.py.
package discovery

import (
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"gopkg.in/yaml.v3"

	"traceo/internal/db"
	"traceo/internal/httpx"
	"traceo/internal/models"
	"traceo/internal/modules/autopilot"
)

const (
	maxSpecBytes = 5 * 1024 * 1024
	fetchTimeout = 10 // seconds
	maxRedirects = 3
)

var httpMethods = []string{"get", "post", "put", "patch", "delete", "head", "options"}
var constraintKeys = []string{"format", "minimum", "maximum", "minLength", "maxLength", "pattern", "enum"}

func Register(r *gin.RouterGroup) {
	r.POST("/projects/:project_id/api-specs", httpx.Auth(), httpx.Require("import_spec"), importAPISpec)
	r.GET("/projects/:project_id/endpoints", httpx.Auth(), httpx.Require("view"), listEndpoints)
	r.PATCH("/endpoints/:endpoint_id", httpx.Auth(), httpx.Require("import_spec"), updateEndpoint)
}

// errWith writes the FastAPI error envelope carrying an extra "errors" list.
func errWith(c *gin.Context, status int, code, message string, errs []string) {
	c.AbortWithStatusJSON(status, gin.H{"detail": gin.H{
		"code": code, "message": message, "errors": errs}})
}

// specError carries an HTTP error through the parse/fetch pipeline.
type specError struct {
	Code    string
	Message string
	Errors  []string
}

func (e *specError) Error() string { return e.Message }

func writeSpecError(c *gin.Context, err error) {
	if se, ok := err.(*specError); ok {
		if se.Errors != nil {
			errWith(c, http.StatusUnprocessableEntity, se.Code, se.Message, se.Errors)
		} else {
			httpx.Err(c, http.StatusUnprocessableEntity, se.Code, se.Message)
		}
		return
	}
	httpx.Err(c, http.StatusUnprocessableEntity, "fetch_failed", err.Error())
}

// --- SSRF-guarded URL fetch ----------------------------------------------------------

// assertPublicHost resolves the hostname and rejects private/loopback/link-local/
// metadata targets.
func assertPublicHost(hostname string) error {
	if hostname == "" {
		return &specError{Code: "invalid_url", Message: "URL has no host."}
	}
	ips, err := net.LookupIP(hostname)
	if err != nil {
		return &specError{Code: "unresolvable_host",
			Message: fmt.Sprintf("Cannot resolve host '%s'.", hostname)}
	}
	for _, ip := range ips {
		if isBlockedIP(ip) {
			return &specError{Code: "ssrf_blocked",
				Message: "URL resolves to a private, loopback, or metadata address."}
		}
	}
	return nil
}

func isBlockedIP(ip net.IP) bool {
	if ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() ||
		ip.IsMulticast() || ip.IsUnspecified() {
		return true
	}
	if ip.String() == "169.254.169.254" {
		return true
	}
	// reserved (240.0.0.0/4 and friends)
	if v4 := ip.To4(); v4 != nil && v4[0] >= 240 {
		return true
	}
	return false
}

// fetchSpec GETs the spec with a 10s timeout, 5MB cap, http/https only, and manual
// redirect following (max 3 hops) so every hop's host passes the SSRF guard.
func fetchSpec(rawURL string) ([]byte, error) {
	client := &http.Client{
		Timeout: fetchTimeout * time.Second,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	redirects := 0
	for {
		parts, err := url.Parse(rawURL)
		if err != nil {
			return nil, &specError{Code: "invalid_url", Message: "Only http/https URLs are allowed."}
		}
		if parts.Scheme != "http" && parts.Scheme != "https" {
			return nil, &specError{Code: "invalid_url", Message: "Only http/https URLs are allowed."}
		}
		if err := assertPublicHost(parts.Hostname()); err != nil {
			return nil, err
		}
		resp, err := client.Get(rawURL)
		if err != nil {
			return nil, &specError{Code: "fetch_failed", Message: "Could not fetch URL (network error)."}
		}
		switch resp.StatusCode {
		case 301, 302, 303, 307, 308:
			io.Copy(io.Discard, io.LimitReader(resp.Body, 1024))
			resp.Body.Close()
			redirects++
			if redirects > maxRedirects {
				return nil, &specError{Code: "too_many_redirects",
					Message: fmt.Sprintf("More than %d redirects.", maxRedirects)}
			}
			location := resp.Header.Get("Location")
			if location == "" {
				return nil, &specError{Code: "bad_redirect",
					Message: "Redirect without a Location header."}
			}
			next, err := parts.Parse(location)
			if err != nil {
				return nil, &specError{Code: "bad_redirect",
					Message: "Redirect without a Location header."}
			}
			rawURL = next.String()
			continue
		}
		if resp.StatusCode >= 400 {
			resp.Body.Close()
			return nil, &specError{Code: "fetch_failed",
				Message: fmt.Sprintf("URL returned HTTP %d.", resp.StatusCode)}
		}
		if resp.ContentLength > maxSpecBytes {
			resp.Body.Close()
			return nil, &specError{Code: "spec_too_large",
				Message: "Specification exceeds the 5MB limit."}
		}
		buf, err := io.ReadAll(io.LimitReader(resp.Body, maxSpecBytes+1))
		resp.Body.Close()
		if err != nil {
			return nil, &specError{Code: "fetch_failed", Message: "Could not fetch URL (read error)."}
		}
		if len(buf) > maxSpecBytes {
			return nil, &specError{Code: "spec_too_large",
				Message: "Specification exceeds the 5MB limit."}
		}
		return buf, nil
	}
}

// --- parsing & structural validation --------------------------------------------------

// normalizeYAML converts map[any]any keys (and all nested values) to string-keyed maps.
func normalizeYAML(v any) any {
	switch t := v.(type) {
	case map[string]any:
		out := make(map[string]any, len(t))
		for k, val := range t {
			out[k] = normalizeYAML(val)
		}
		return out
	case map[any]any:
		out := make(map[string]any, len(t))
		for k, val := range t {
			out[fmt.Sprint(k)] = normalizeYAML(val)
		}
		return out
	case []any:
		out := make([]any, len(t))
		for i, val := range t {
			out[i] = normalizeYAML(val)
		}
		return out
	}
	return v
}

func parseSpecBytes(raw []byte) (any, error) {
	text := string(raw)
	stripped := strings.TrimLeft(text, " \t\r\n\v\f")
	if strings.HasPrefix(stripped, "{") || strings.HasPrefix(stripped, "[") {
		var out any
		if err := json.Unmarshal([]byte(text), &out); err != nil {
			return nil, &specError{Code: "parse_error",
				Message: "Invalid JSON specification.", Errors: []string{err.Error()}}
		}
		return out, nil
	}
	var out any
	if err := yaml.Unmarshal([]byte(text), &out); err != nil {
		return nil, &specError{Code: "parse_error",
			Message: "Invalid YAML specification.", Errors: []string{err.Error()}}
	}
	return normalizeYAML(out), nil
}

// validateStructure returns "openapi3" | "swagger2", or a 422 specError with errors.
func validateStructure(spec any) (string, map[string]any, error) {
	root, isMap := spec.(map[string]any)
	if !isMap {
		return "", nil, &specError{Code: "invalid_spec",
			Message: "Not a valid API specification.",
			Errors:  []string{"Specification root must be a mapping/object."}}
	}
	var errs []string
	format := ""
	if root["swagger"] == "2.0" {
		format = "swagger2"
	} else if v, ok := root["openapi"]; ok && strings.HasPrefix(fmt.Sprint(v), "3") {
		format = "openapi3"
	} else {
		errs = append(errs, "Missing version marker: expected 'openapi: 3.x' or 'swagger: \"2.0\"'.")
	}
	paths, pathsOK := root["paths"].(map[string]any)
	if !pathsOK {
		errs = append(errs, "Specification has no 'paths' object.")
	} else if len(paths) == 0 {
		errs = append(errs, "'paths' object is empty — nothing to import.")
	}
	if len(errs) > 0 {
		return "", nil, &specError{Code: "invalid_spec",
			Message: "Not a valid API specification.", Errors: errs}
	}
	return format, root, nil
}

// --- $ref resolution (internal refs only, cycle-safe) ----------------------------------

func resolveRefs(node any, root map[string]any, seen map[string]bool) (any, error) {
	switch t := node.(type) {
	case map[string]any:
		if ref, isStr := t["$ref"].(string); isStr {
			if !strings.HasPrefix(ref, "#/") {
				return nil, fmt.Errorf("unsupported external $ref: %s", ref)
			}
			if seen[ref] {
				return map[string]any{"type": "object"}, nil // cycle — collapse to opaque object
			}
			var target any = root
			for _, part := range strings.Split(ref[2:], "/") {
				part = strings.ReplaceAll(strings.ReplaceAll(part, "~1", "/"), "~0", "~")
				m, isMap := target.(map[string]any)
				if !isMap {
					return nil, fmt.Errorf("broken $ref: %s", ref)
				}
				next, present := m[part]
				if !present {
					return nil, fmt.Errorf("broken $ref: %s", ref)
				}
				target = next
			}
			branch := make(map[string]bool, len(seen)+1)
			for k := range seen {
				branch[k] = true
			}
			branch[ref] = true
			return resolveRefs(target, root, branch)
		}
		out := make(map[string]any, len(t))
		for k, v := range t {
			rv, err := resolveRefs(v, root, seen)
			if err != nil {
				return nil, err
			}
			out[k] = rv
		}
		return out, nil
	case []any:
		out := make([]any, len(t))
		for i, v := range t {
			rv, err := resolveRefs(v, root, seen)
			if err != nil {
				return nil, err
			}
			out[i] = rv
		}
		return out, nil
	}
	return node, nil
}

// --- flattening ------------------------------------------------------------------------

func constraintsFrom(schema map[string]any) map[string]any {
	out := map[string]any{}
	for _, k := range constraintKeys {
		if v, present := schema[k]; present {
			out[k] = v
		}
	}
	return out
}

// jsonMediaSchema prefers application/json, then the first declared media type.
func jsonMediaSchema(container map[string]any) map[string]any {
	content, ok := container["content"].(map[string]any)
	if !ok || len(content) == 0 {
		return nil
	}
	media, ok := content["application/json"].(map[string]any)
	if !ok {
		keys := make([]string, 0, len(content))
		for k := range content {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			if m, isMap := content[k].(map[string]any); isMap {
				media = m
				break
			}
		}
	}
	if media == nil {
		return nil
	}
	schema, _ := media["schema"].(map[string]any)
	return schema
}

func truthy(v any) bool {
	switch t := v.(type) {
	case bool:
		return t
	case nil:
		return false
	case string:
		return t != ""
	case int:
		return t != 0
	case float64:
		return t != 0
	}
	return true
}

func stringOr(v any, def string) string {
	if s, ok := v.(string); ok {
		return s
	}
	if v == nil {
		return def
	}
	return fmt.Sprint(v)
}

// collectParams normalizes parameters; a swagger2 body parameter becomes the
// request_schema. Operation-level parameters override path-level (same name+in),
// keeping the first-seen position — Python dict semantics.
func collectParams(rawParams []map[string]any, format string) ([]any, map[string]any) {
	var requestSchema map[string]any
	type mergeKey struct{ name, in string }
	order := []mergeKey{}
	merged := map[mergeKey]map[string]any{}
	for _, p := range rawParams {
		name, _ := p["name"].(string)
		in, _ := p["in"].(string)
		if name == "" && in != "body" {
			continue
		}
		k := mergeKey{name, in}
		if _, present := merged[k]; !present {
			order = append(order, k)
		}
		merged[k] = p
	}

	params := []any{}
	for _, k := range order {
		p := merged[k]
		location, _ := p["in"].(string)
		if format == "swagger2" && location == "body" {
			requestSchema, _ = p["schema"].(map[string]any)
			continue
		}
		// openapi3 keeps the schema nested; swagger2 non-body params carry it inline
		schemaSrc := p
		if s, isMap := p["schema"].(map[string]any); isMap {
			schemaSrc = s
		}
		required := location == "path"
		if v, present := p["required"]; present {
			required = truthy(v)
		}
		params = append(params, map[string]any{
			"name":        stringOr(p["name"], ""),
			"location":    location, // path|query|header|cookie|formData
			"type":        stringOr(schemaSrc["type"], ""),
			"required":    required,
			"constraints": constraintsFrom(schemaSrc),
		})
	}
	return params, requestSchema
}

func responseSchemas(op map[string]any, format string) map[string]any {
	out := map[string]any{}
	responses, _ := op["responses"].(map[string]any)
	for status, robjAny := range responses {
		robj, isMap := robjAny.(map[string]any)
		if !isMap {
			continue
		}
		var schema map[string]any
		if format == "swagger2" {
			schema, _ = robj["schema"].(map[string]any)
		} else {
			schema = jsonMediaSchema(robj)
		}
		if schema != nil {
			out[status] = schema
		}
	}
	return out
}

type operation struct {
	Method          string
	Path            string
	OperationID     string
	Summary         string
	Parameters      []any
	RequestSchema   map[string]any
	ResponseSchemas map[string]any
	Security        []any
	Tags            []any
}

// flatten turns every operation into an endpoint dict. A broken operation is appended
// to warnings and skipped — one bad ref never sinks the import (FR-DSC-04).
func flatten(spec map[string]any, format string) ([]operation, []gin.H) {
	operations := []operation{}
	warnings := []gin.H{}
	rootSecurity, _ := spec["security"].([]any)
	if rootSecurity == nil {
		rootSecurity = []any{}
	}

	paths, _ := spec["paths"].(map[string]any)
	pathKeys := make([]string, 0, len(paths))
	for k := range paths {
		pathKeys = append(pathKeys, k)
	}
	sort.Strings(pathKeys)

	for _, path := range pathKeys {
		item, isMap := paths[path].(map[string]any)
		if !isMap {
			warnings = append(warnings, gin.H{"path": path, "method": "*",
				"error": "Path item is not an object."})
			continue
		}
		for _, method := range httpMethods {
			opRaw, isOp := item[method].(map[string]any)
			if !isOp {
				continue
			}
			op, err := flattenOne(spec, format, path, method, item, opRaw, rootSecurity)
			if err != nil {
				warnings = append(warnings, gin.H{"path": path,
					"method": strings.ToUpper(method), "error": err.Error()})
				continue
			}
			operations = append(operations, op)
		}
	}
	return operations, warnings
}

func flattenOne(spec map[string]any, format, path, method string, item, opRaw map[string]any,
	rootSecurity []any) (operation, error) {
	resolvedAny, err := resolveRefs(opRaw, spec, map[string]bool{})
	if err != nil {
		return operation{}, err
	}
	resolved, isMap := resolvedAny.(map[string]any)
	if !isMap {
		return operation{}, fmt.Errorf("operation did not resolve to an object")
	}

	rawParams := []map[string]any{}
	if pathParams, isList := item["parameters"].([]any); isList {
		for _, p := range pathParams {
			pm, isMap := p.(map[string]any)
			if !isMap {
				continue
			}
			rp, rerr := resolveRefs(pm, spec, map[string]bool{})
			if rerr != nil {
				return operation{}, rerr
			}
			rawParams = append(rawParams, rp.(map[string]any))
		}
	}
	if opParams, isList := resolved["parameters"].([]any); isList {
		for _, p := range opParams {
			if pm, isMap := p.(map[string]any); isMap {
				rawParams = append(rawParams, pm)
			}
		}
	}
	params, requestSchema := collectParams(rawParams, format)
	if format == "openapi3" && requestSchema == nil {
		if body, isMap := resolved["requestBody"].(map[string]any); isMap {
			requestSchema = jsonMediaSchema(body)
		}
	}
	var security []any
	if v, present := resolved["security"]; present {
		security, _ = v.([]any)
		if security == nil {
			security = []any{}
		}
	} else {
		security = rootSecurity
	}
	summary := stringOr(resolved["summary"], "")
	if summary == "" {
		summary = stringOr(resolved["description"], "")
	}
	if r := []rune(summary); len(r) > 500 {
		summary = string(r[:500])
	}
	tags := []any{}
	if tl, isList := resolved["tags"].([]any); isList {
		for _, t := range tl {
			tags = append(tags, fmt.Sprint(t))
		}
	}
	return operation{
		Method:          strings.ToUpper(method),
		Path:            path,
		OperationID:     stringOr(resolved["operationId"], ""),
		Summary:         summary,
		Parameters:      params,
		RequestSchema:   requestSchema,
		ResponseSchemas: responseSchemas(resolved, format),
		Security:        security,
		Tags:            tags,
	}, nil
}

// --- diff & serialization ---------------------------------------------------------------

func opKey(method, path string) string {
	return strings.ToUpper(method) + " " + path
}

// signature canonicalizes the grounding-relevant shape of an operation.
// encoding/json sorts map keys, matching Python's json.dumps(sort_keys=True).
func signature(parameters any, requestSchema any, respSchemas any, security any) string {
	b, err := json.Marshal(map[string]any{
		"p": parameters, "rq": requestSchema, "rs": respSchemas, "sec": security})
	if err != nil {
		return fmt.Sprintf("%v|%v|%v|%v", parameters, requestSchema, respSchemas, security)
	}
	return string(b)
}

func endpointDict(e *models.Endpoint) gin.H {
	parameters := e.Parameters
	if parameters == nil {
		parameters = models.JSONList{}
	}
	var requestSchema any
	if len(e.RequestSchema) > 0 {
		requestSchema = e.RequestSchema
	}
	respSchemas := e.ResponseSchemas
	if respSchemas == nil {
		respSchemas = models.JSONMap{}
	}
	security := e.Security
	if security == nil {
		security = models.JSONList{}
	}
	tags := e.Tags
	if tags == nil {
		tags = models.JSONList{}
	}
	return gin.H{
		"id": e.ID, "api_spec_id": e.ApiSpecID, "project_id": e.ProjectID,
		"method": e.Method, "path": e.Path, "operation_id": e.OperationID,
		"summary": e.Summary, "parameters": parameters,
		"request_schema": requestSchema, "response_schemas": respSchemas,
		"security": security, "tags": tags, "excluded": e.Excluded,
		// Which discovery mode found this endpoint, and how many times traffic
		// capture observed it — shown on the coverage map (FR-024) once the
		// non-spec modes land (FR-021/022/023).
		"source": e.Source, "observed_count": e.ObservedCount,
	}
}

// --- routes -------------------------------------------------------------------------------

func importAPISpec(c *gin.Context) {
	projectID := c.Param("project_id")
	if _, ok := httpx.ProjectScoped(c, projectID); !ok {
		return
	}
	u := httpx.User(c)

	var raw []byte
	var source string
	contentType := strings.ToLower(c.GetHeader("Content-Type"))
	if strings.HasPrefix(contentType, "multipart/") {
		fh, err := c.FormFile("file")
		if err != nil {
			httpx.Err(c, http.StatusUnprocessableEntity, "missing_file",
				"Multipart request must include a 'file' part.")
			return
		}
		src, err := fh.Open()
		if err != nil {
			httpx.Err(c, http.StatusUnprocessableEntity, "missing_file",
				"Multipart request must include a 'file' part.")
			return
		}
		defer src.Close()
		raw, err = io.ReadAll(io.LimitReader(src, maxSpecBytes+1))
		if err != nil || len(raw) > maxSpecBytes {
			httpx.Err(c, http.StatusUnprocessableEntity, "spec_too_large",
				"Specification exceeds the 5MB limit.")
			return
		}
		source = fh.Filename
		if source == "" {
			source = "spec"
		}
	} else {
		var body map[string]any
		_ = c.ShouldBindJSON(&body)
		urlStr, isStr := body["url"].(string)
		if !isStr || urlStr == "" {
			httpx.Err(c, http.StatusUnprocessableEntity, "invalid_request",
				"Provide a multipart 'file' or a JSON body {\"url\": \"...\"}.")
			return
		}
		fetched, err := fetchSpec(urlStr)
		if err != nil {
			writeSpecError(c, err)
			return
		}
		raw = fetched
		source = urlStr
	}

	spec, err := parseSpecBytes(raw)
	if err != nil {
		writeSpecError(c, err)
		return
	}
	format, root, err := validateStructure(spec)
	if err != nil {
		writeSpecError(c, err)
		return
	}
	operations, warnings := flatten(root, format)

	// swagger2 host/basePath are recorded as spec source metadata
	if format == "swagger2" {
		notes := []string{}
		for _, key := range []string{"host", "basePath"} {
			if v, present := root[key]; present && truthy(v) {
				notes = append(notes, fmt.Sprintf("%s=%v", key, v))
			}
		}
		if len(notes) > 0 {
			source = fmt.Sprintf("%s [%s]", source, strings.Join(notes, "; "))
		}
	}
	if r := []rune(source); len(r) > 500 {
		source = string(r[:500])
	}
	title := ""
	if info, isMap := root["info"].(map[string]any); isMap {
		title = stringOr(info["title"], "")
	}
	if r := []rune(title); len(r) > 300 {
		title = string(r[:300])
	}

	var oldRows []models.Endpoint
	db.DB.Where("project_id = ? AND organisation_id = ?", projectID, u.OrganisationID).Find(&oldRows)
	oldByKey := map[string]*models.Endpoint{}
	for i := range oldRows {
		oldByKey[opKey(oldRows[i].Method, oldRows[i].Path)] = &oldRows[i]
	}
	newByKey := map[string]operation{}
	newOrder := []string{}
	for _, op := range operations {
		k := opKey(op.Method, op.Path)
		if _, present := newByKey[k]; !present {
			newOrder = append(newOrder, k)
		}
		newByKey[k] = op
	}

	added := []string{}
	removed := []string{}
	changed := []string{}
	for k := range newByKey {
		if _, present := oldByKey[k]; !present {
			added = append(added, k)
		}
	}
	for k := range oldByKey {
		if _, present := newByKey[k]; !present {
			removed = append(removed, k)
		}
	}
	for k, op := range newByKey {
		old, present := oldByKey[k]
		if !present {
			continue
		}
		newSig := signature(op.Parameters, op.RequestSchema, op.ResponseSchemas, op.Security)
		oldSig := signature(old.Parameters, mapOrNil(old.RequestSchema), old.ResponseSchemas, old.Security)
		if newSig != oldSig {
			changed = append(changed, k)
		}
	}
	sort.Strings(added)
	sort.Strings(removed)
	sort.Strings(changed)
	diff := gin.H{"added": added, "removed": removed, "changed": changed}

	var specRow models.ApiSpec
	found := db.DB.Where("project_id = ? AND organisation_id = ?", projectID, u.OrganisationID).
		Order("version DESC").First(&specRow).Error == nil
	if found {
		specRow.Version++
		specRow.Source = source
		specRow.Format = format
		specRow.Title = title
		db.DB.Save(&specRow)
	} else {
		specRow = models.ApiSpec{
			OrganisationID: u.OrganisationID, ProjectID: projectID,
			Source: source, Format: format, Version: 1, Title: title,
		}
		db.DB.Create(&specRow)
	}

	// REPLACE the inventory: detach grounding links, drop old rows, insert fresh ones
	if len(oldRows) > 0 {
		oldIDs := make([]string, 0, len(oldRows))
		for _, e := range oldRows {
			oldIDs = append(oldIDs, e.ID)
		}
		db.DB.Model(&models.TestStep{}).Where("endpoint_id IN ?", oldIDs).
			Update("endpoint_id", nil)
		db.DB.Where("id IN ?", oldIDs).Delete(&models.Endpoint{})
	}

	for _, k := range newOrder {
		op := newByKey[k]
		excluded := false
		if prior, present := oldByKey[k]; present {
			excluded = prior.Excluded // FR-DSC-05 survives re-import
		}
		var reqSchema models.JSONMap
		if op.RequestSchema != nil {
			reqSchema = models.JSONMap(op.RequestSchema)
		}
		db.DB.Create(&models.Endpoint{
			OrganisationID: u.OrganisationID, ApiSpecID: specRow.ID,
			ProjectID: projectID, Method: op.Method, Path: op.Path,
			OperationID: op.OperationID, Summary: op.Summary,
			Parameters:      models.JSONList(op.Parameters),
			RequestSchema:   reqSchema,
			ResponseSchemas: models.JSONMap(op.ResponseSchemas),
			Security:        models.JSONList(op.Security),
			Tags:            models.JSONList(op.Tags),
			Excluded:        excluded,
		})
	}

	httpx.Audit(u.OrganisationID, &u.ID, "spec.imported", "api_spec", specRow.ID,
		models.JSONMap{"source": source, "format": format, "version": specRow.Version,
			"endpoints": len(newByKey), "warnings": len(warnings)})

	// Autopilot generation trigger (automation contract 4b) — auto mode only;
	// enqueues asynchronously, the import response is unchanged.
	autopilot.AfterSpecImport(projectID, u.OrganisationID, u.ID)

	c.JSON(http.StatusCreated, gin.H{
		"spec_id":         specRow.ID,
		"version":         specRow.Version,
		"endpoints_count": len(newByKey),
		"warnings":        warnings,
		"diff":            diff,
	})
}

func mapOrNil(m models.JSONMap) any {
	if len(m) == 0 {
		return nil
	}
	return m
}

// --- FR-024 endpoint coverage (computed at read time from approved-case steps) ---------

type coverageInfo struct {
	TestCount        int
	CoveredParamsPct float64
	LastOutcome      any
}

func endpointCoverage(projectID, orgID string, endpoints []models.Endpoint) map[string]*coverageInfo {
	out := map[string]*coverageInfo{}
	epIDs := make([]string, 0, len(endpoints))
	for _, e := range endpoints {
		out[e.ID] = &coverageInfo{TestCount: 0, CoveredParamsPct: 100.0, LastOutcome: nil}
		epIDs = append(epIDs, e.ID)
	}
	if len(epIDs) == 0 {
		return out
	}

	type stepRow struct {
		EndpointID string
		TestCaseID string
		Request    models.JSONMap
	}
	var stepRows []stepRow
	db.DB.Table("test_steps").
		Select("test_steps.endpoint_id AS endpoint_id, test_steps.test_case_id AS test_case_id, test_steps.request AS request").
		Joins("JOIN test_cases ON test_cases.id = test_steps.test_case_id").
		Where("test_steps.endpoint_id IN ? AND test_cases.state = ? AND test_cases.project_id = ? AND test_cases.organisation_id = ?",
			epIDs, "approved", projectID, orgID).
		Scan(&stepRows)

	casesByEp := map[string]map[string]bool{}
	epsByCase := map[string]map[string]bool{}
	referenced := map[string]map[string]bool{}
	for _, row := range stepRows {
		if casesByEp[row.EndpointID] == nil {
			casesByEp[row.EndpointID] = map[string]bool{}
		}
		casesByEp[row.EndpointID][row.TestCaseID] = true
		if epsByCase[row.TestCaseID] == nil {
			epsByCase[row.TestCaseID] = map[string]bool{}
		}
		epsByCase[row.TestCaseID][row.EndpointID] = true
		if referenced[row.EndpointID] == nil {
			referenced[row.EndpointID] = map[string]bool{}
		}
		for _, key := range []string{"params", "headers"} {
			if m, isMap := row.Request[key].(map[string]any); isMap {
				for name := range m {
					referenced[row.EndpointID][strings.ToLower(name)] = true
				}
			}
		}
	}

	for _, e := range endpoints {
		out[e.ID].TestCount = len(casesByEp[e.ID])
		params := []map[string]any{}
		for _, p := range e.Parameters {
			if pm, isMap := p.(map[string]any); isMap && pm["name"] != nil && fmt.Sprint(pm["name"]) != "" {
				params = append(params, pm)
			}
		}
		if len(params) > 0 {
			refs := referenced[e.ID]
			covered := 0
			for _, p := range params {
				if refs[strings.ToLower(fmt.Sprint(p["name"]))] {
					covered++
				}
			}
			out[e.ID].CoveredParamsPct = math.Round(float64(covered)/float64(len(params))*1000) / 10
		}
	}

	caseIDs := make([]string, 0, len(epsByCase))
	for id := range epsByCase {
		caseIDs = append(caseIDs, id)
	}
	if len(caseIDs) > 0 {
		type resRow struct {
			TestCaseID string
			Outcome    string
		}
		var resRows []resRow
		db.DB.Table("test_results").
			Select("test_case_id, outcome").
			Where("test_case_id IN ?", caseIDs).
			Order("created_at ASC, id ASC").
			Scan(&resRows)
		for _, row := range resRows { // ascending: the last write wins = newest
			for epID := range epsByCase[row.TestCaseID] {
				out[epID].LastOutcome = row.Outcome
			}
		}
	}
	return out
}

func listEndpoints(c *gin.Context) {
	projectID := c.Param("project_id")
	if _, ok := httpx.ProjectScoped(c, projectID); !ok {
		return
	}
	u := httpx.User(c)
	var rows []models.Endpoint
	db.DB.Where("project_id = ? AND organisation_id = ?", projectID, u.OrganisationID).
		Order("path ASC, method ASC").Find(&rows)
	coverage := endpointCoverage(projectID, u.OrganisationID, rows)
	payload := make([]gin.H, 0, len(rows))
	for i := range rows {
		d := endpointDict(&rows[i])
		info := coverage[rows[i].ID]
		d["test_count"] = info.TestCount
		d["covered_params_pct"] = info.CoveredParamsPct
		d["last_outcome"] = info.LastOutcome
		payload = append(payload, d)
	}
	c.JSON(http.StatusOK, payload)
}

func updateEndpoint(c *gin.Context) {
	u := httpx.User(c)
	var endpoint models.Endpoint
	if err := db.DB.First(&endpoint, "id = ? AND organisation_id = ?",
		c.Param("endpoint_id"), u.OrganisationID).Error; err != nil {
		httpx.Err(c, http.StatusNotFound, "not_found", "Endpoint not found")
		return
	}
	var body map[string]any
	_ = c.ShouldBindJSON(&body)
	excluded, isBool := body["excluded"].(bool)
	if !isBool {
		httpx.Err(c, http.StatusUnprocessableEntity, "invalid_request",
			"Body must be {\"excluded\": true|false}.")
		return
	}
	endpoint.Excluded = excluded
	db.DB.Save(&endpoint)
	httpx.Audit(u.OrganisationID, &u.ID, "endpoint.excluded_toggled", "endpoint", endpoint.ID,
		models.JSONMap{"excluded": excluded})
	c.JSON(http.StatusOK, endpointDict(&endpoint))
}

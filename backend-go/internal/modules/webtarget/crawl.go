package webtarget

// The authenticated crawl — port of the crawl half of
// backend/app/modules/webtarget.py. Same constants, same coercion rules, same
// refusal codes and the same JSON, because a client must not be able to tell the
// two engines apart.
//
// THE SAFETY RULE, stated here exactly as it is stated in the sidecar and in the
// docs:
//
//	The crawler submits THE LOGIN FORM ONLY, once, with the credentials the
//	user supplied. It submits no other form, ever. It clicks no control whose
//	accessible name or href matches logout / sign out / delete / remove /
//	destroy / reset / deactivate / terminate. It stays on the login URL's
//	origin. It follows links only.
//
// A crawl that cannot PROVE it signed in fails with login_failed. It never falls
// back to browsing anonymously and reporting success — that would silently test
// the logged-out product and call it the real one.

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"math"
	"strconv"
	"strings"
)

const (
	// The crawl page budget. The DEFAULT explores, because a user who hands
	// Traceo a URL is asking about the product, not about one screen. 50 is the
	// ceiling rather than the default because a crawl runs against somebody
	// else's server.
	MinPages        = 1
	DefaultMaxPages = 25
	MaxPages        = 50
	DefaultMaxDepth = 3

	// CrawlPasswordEnv is where the sidecar reads the password. It is not on
	// argv because argv is world-readable through `ps` on a shared host, and a
	// password in a job log or a process list is a real incident, not a
	// tidiness complaint.
	CrawlPasswordEnv = "TRACEO_CRAWL_PASSWORD"

	LoginFailed = "login_failed"
	// LoginFailedMessage is deliberately generic. Saying "wrong password" would
	// confirm that the username exists — the same reason identity answers a bad
	// sign-in with one 401.
	LoginFailedMessage = "The site rejected the sign-in credentials for this target, so " +
		"the crawl stopped before visiting any page. Check the username and password " +
		"and try again."
)

// credentialSources is where a credential came from. Never a value — only its
// provenance.
var credentialSources = map[string]bool{"user": true, "page": true}

// CrawlPlan is what this run asks the sidecar to do beyond rendering one page.
// Holding the password in one struct rather than threading it through six
// arguments is what keeps it out of the places it must never reach: it is
// written to exactly one map (the child's environment) and read nowhere else.
type CrawlPlan struct {
	MaxPages int
	MaxDepth int
	Username string
	Password string
}

// SignsIn reports whether this plan has credentials to submit.
func (p *CrawlPlan) SignsIn() bool {
	return p != nil && p.Username != "" && p.Password != ""
}

// ValidateMaxPages coerces and bounds the page budget. An absent value KEEPS
// what the target was configured with, so re-running a crawl from the list does
// not silently shrink it while its credentials are still attached. Returns
// ok=false for anything that is not a whole page count in range.
func ValidateMaxPages(raw any, current int) (int, bool) {
	if raw == nil {
		return current, true
	}
	var value int
	switch t := raw.(type) {
	case bool:
		return 0, false
	case string:
		n, err := strconv.Atoi(strings.TrimSpace(t))
		if err != nil {
			return 0, false
		}
		value = n
	case float64:
		if math.IsNaN(t) || math.IsInf(t, 0) || t != math.Trunc(t) {
			return 0, false
		}
		value = int(t)
	case int:
		value = t
	default:
		return 0, false
	}
	if value < MinPages || value > MaxPages {
		return 0, false
	}
	return value, true
}

// ValidateAuth returns the credentials when sign-in was requested. ok=false
// means the request is refused; the caller's refusal names neither value and
// does not say which of the two was blank. The password is NOT trimmed —
// leading or trailing space can be part of a real password — but a value that is
// only whitespace is blank.
func ValidateAuth(raw any) (username, password string, present, ok bool) {
	if raw == nil {
		return "", "", false, true
	}
	m, isMap := raw.(map[string]any)
	if !isMap {
		return "", "", true, false
	}
	u, uIsString := m["username"].(string)
	p, pIsString := m["password"].(string)
	if !uIsString || !pIsString ||
		strings.TrimSpace(u) == "" || strings.TrimSpace(p) == "" {
		return "", "", true, false
	}
	return strings.TrimSpace(u), p, true, true
}

// ---------------------------------------------------------------------------
// The crawl document
// ---------------------------------------------------------------------------

// NormalisePages is every page the crawl visited, page[0] being the target
// itself. A single-page document has no `pages` array — it IS one page, and
// reading it that way is what keeps one code path for both shapes. Page 0
// mirrors the top-level fields by contract, so anything the sidecar states only
// at the top level still belongs to the page that produced it.
func NormalisePages(doc map[string]any) []Inventory {
	var raw []map[string]any
	for _, item := range asList(doc["pages"]) {
		if m := asMap(item); m != nil {
			raw = append(raw, m)
		}
	}
	if len(raw) == 0 {
		page := NormalisePayload(doc)
		page.Depth = 0
		page.Status = intPtr(doc["status"])
		return []Inventory{page}
	}
	inherited := []string{"url", "final_url", "title", "viewport", "elapsed_ms",
		"screenshot", "forms", "controls", "requests", "console_errors"}
	out := make([]Inventory, 0, len(raw))
	for index, item := range raw {
		merged := map[string]any{}
		for k, v := range item {
			merged[k] = v
		}
		if index == 0 {
			for _, key := range inherited {
				if isBlank(merged[key]) && !isBlank(doc[key]) {
					merged[key] = doc[key]
				}
			}
		}
		page := NormalisePayload(merged)
		if d := intPtr(item["depth"]); d != nil {
			page.Depth = *d
		}
		page.Status = intPtr(item["status"])
		out = append(out, page)
	}
	return out
}

// isBlank mirrors Python's falsy test for the inherited keys: absent, empty
// string and empty list all mean "the page said nothing here".
func isBlank(v any) bool {
	switch t := v.(type) {
	case nil:
		return true
	case string:
		return t == ""
	case []any:
		return len(t) == 0
	case float64:
		return t == 0
	case bool:
		return !t
	}
	return false
}

// PageToken is the id fragment that scopes a requirement to the page that
// stated it.
//
// Index 0 is the target itself and keeps the id scheme targets have always used,
// so a target that later grows a second page does not re-key the requirements
// already derived from its first one. Every other page is keyed on its own URL —
// that survives a page appearing or vanishing ahead of it in the breadth-first
// order, which a positional index would not.
func PageToken(page Inventory, index int) string {
	if index == 0 {
		return ""
	}
	target := page.FinalURL
	if target == "" {
		target = page.URL
	}
	sum := sha256.Sum256([]byte(target))
	return "-P" + strings.ToUpper(hex.EncodeToString(sum[:])[:8])
}

// LoginForm is the page's login form: the first one carrying a password field.
// This is the same test the crawler uses to decide a page wants signing into.
// Repeating it here is deliberate — it is what lets the backend report
// login_required with the form's OWN selectors even when the sidecar told us
// nothing beyond the DOM it captured.
func LoginForm(inv Inventory) *Form {
	for i := range inv.Forms {
		for _, field := range inv.Forms[i].Fields {
			if strings.ToLower(field.Type) == "password" {
				return &inv.Forms[i]
			}
		}
	}
	return nil
}

// LoginReport is what happened at the sign-in gate, with nothing in it that
// could leak. The sidecar's `error` string is dropped outright — it is the one
// field a sidecar bug could fill with a credential, and no reader downstream
// could tell.
type LoginReport struct {
	Attempted         bool
	Succeeded         bool
	Strategy          string
	CredentialsSource string
	Reauthenticated   int
	// Error is the sidecar's login verdict as a CODE, never its sentence.
	Error string
}

// loginErrorCodes is the closed set a login verdict may reduce to.
var loginErrorCodes = map[string]bool{"login_required": true, "login_failed": true}

// LoginErrorCode is the sidecar's login error reduced to a code, or "".
//
// The accompanying message is dropped and the code is checked against a closed
// set. That is what lets `login_required` — the outcome that says "signing in
// would unlock more of this product" — survive normalisation without opening the
// one field a credential could be written into.
func LoginErrorCode(raw map[string]any) string {
	code := ""
	switch err := raw["error"].(type) {
	case map[string]any:
		code = trunc(str(err["code"]), 40)
	case string:
		code = trunc(err, 40)
	}
	if loginErrorCodes[code] {
		return code
	}
	return ""
}

// NormaliseLogin reduces the sidecar's login block. `credentials_source` is
// decided here rather than trusted from the sidecar for the half that matters:
// only THIS process knows whether the operator supplied anything, so the sidecar
// cannot cause a user secret to be labelled a page fact.
func NormaliseLogin(doc map[string]any, supplied bool) *LoginReport {
	raw := asMap(doc["login"])
	if raw == nil {
		return nil
	}
	succeeded := truthy(raw["succeeded"])
	source := trunc(str(raw["credentials_source"]), 10)
	switch {
	case supplied:
		source = "user"
	case !credentialSources[source]:
		source = ""
	}
	if !succeeded || source == "" {
		source = ""
	}
	reauth := 0
	if n := intPtr(raw["reauthenticated"]); n != nil {
		reauth = *n
	}
	return &LoginReport{
		Attempted: truthy(raw["attempted"]), Succeeded: succeeded,
		Strategy: trunc(str(raw["strategy"]), 60), CredentialsSource: source,
		Reauthenticated: reauth, Error: LoginErrorCode(raw),
	}
}

// NormaliseCrawl is the crawl's own account of itself: what it asked for, what
// it reached, and every URL it refused, with the reason it refused it.
func NormaliseCrawl(doc map[string]any) map[string]any {
	raw := asMap(doc["crawl"])
	if raw == nil {
		raw = map[string]any{}
	}
	skipped := []any{}
	for _, item := range asList(raw["skipped"]) {
		m := asMap(item)
		if m == nil {
			continue
		}
		if len(skipped) >= 200 {
			break
		}
		skipped = append(skipped, map[string]any{
			"url": trunc(str(m["url"]), 1000), "reason": trunc(str(m["reason"]), 200)})
	}
	out := map[string]any{
		"requested_max_pages": nil, "visited": nil,
		"origin": trunc(str(raw["origin"]), 300), "skipped": skipped,
	}
	if n := intPtr(raw["requested_max_pages"]); n != nil {
		out["requested_max_pages"] = *n
	}
	if n := intPtr(raw["visited"]); n != nil {
		out["visited"] = *n
	}
	return out
}

// LoginOutcome is one account of the sign-in gate, whatever happened at it.
//
// There are three outcomes and a reader must be able to tell them apart without
// guessing: signed in, tried and was refused, or never had anything to try. The
// third is NOT an error — a public page is a legitimate thing to test — but it
// is not silence either: the login form's OWN selectors travel with the report,
// so the answer to "what would credentials unlock" points at the element the
// page actually rendered rather than at a suggestion.
func LoginOutcome(login *LoginReport, inv Inventory) map[string]any {
	report := map[string]any{
		"attempted": login != nil && login.Attempted,
		"succeeded": login != nil && login.Succeeded,
		"strategy":  "",
		// Always present, null included: "we did not sign in" and "we signed in
		// somehow" must not look the same to a caller.
		"credentials_source": nil,
		"reauthenticated":    0,
		// The sidecar's own verdict, as a code. login_required is the one that
		// matters: it is the crawler saying it found a gate it could not pass.
		"error":    nil,
		"required": false,
		"form":     nil,
	}
	if login != nil {
		report["strategy"] = login.Strategy
		report["reauthenticated"] = login.Reauthenticated
		if login.CredentialsSource != "" {
			report["credentials_source"] = login.CredentialsSource
		}
		if login.Error != "" {
			report["error"] = login.Error
		}
	}
	if report["succeeded"] == true {
		return report
	}
	// Two independent witnesses, and either is enough: the crawler said the page
	// required a sign-in, or the DOM it captured contains a password field. One
	// without the other used to mean the outcome was never reported at all.
	if report["error"] == "login_required" {
		report["required"] = true
	}
	gate := LoginForm(inv)
	if gate == nil {
		return report // nothing on this page asks to be signed into
	}
	fields := make([]any, 0, len(gate.Fields))
	for _, f := range gate.Fields {
		fields = append(fields, f.Selector)
	}
	report["required"] = true
	report["form"] = map[string]any{
		"selector": gate.Selector, "fields": fields, "submit": gate.Submit}
	return report
}

// OutcomeSentence is what happened, in one sentence, with the numbers in it.
//
// The outcome of a crawl is a REPORT, not a configuration status. Whichever of
// the three ways it went, the user reads the same shape of sentence and never
// has to work out whether an empty box means "nothing there" or "you forgot to
// fill something in".
func OutcomeSentence(report map[string]any, pageCount, skippedCount,
	requirementCount, caseCount int) string {
	plural := func(n int, noun string) string {
		if n == 1 {
			return fmt.Sprintf("%d %s", n, noun)
		}
		return fmt.Sprintf("%d %ss", n, noun)
	}
	body := "crawled " + plural(pageCount, "page")
	if skippedCount > 0 {
		body += fmt.Sprintf(" (%d skipped)", skippedCount)
	}
	body += ", producing " + plural(requirementCount, "requirement") + " and " +
		plural(caseCount, "test case")

	succeeded, _ := report["succeeded"].(bool)
	required, _ := report["required"].(bool)
	attempted, _ := report["attempted"].(bool)
	if succeeded {
		how := "the supplied credentials"
		if source, _ := report["credentials_source"].(string); source == "page" {
			how = "the credentials the sign-in page publishes about itself"
		}
		return "Signed in with " + how + ", then " + body + "."
	}
	if required && attempted {
		return "The credentials found on the sign-in page were rejected, so Traceo " +
			body + " from the public surface only."
	}
	if required {
		return "No credentials were available for the sign-in page, so Traceo " + body +
			" from the public surface only; supplying a username and password unlocks " +
			"the pages behind the form."
	}
	return strings.ToUpper(body[:1]) + body[1:] + "."
}

// CrawlRequests is the XHR/fetch inventory of the whole crawl, deduplicated
// ACROSS pages. Repeats within one page are kept — a page that calls an endpoint
// twice observed it twice — but the same capture seen again on the next page is
// the same fact, not a second observation, and counting it again would inflate
// every endpoint's observed count by the number of pages that load the app shell.
func CrawlRequests(pages []Inventory) []Request {
	out := []Request{}
	seen := map[string]bool{}
	for _, page := range pages {
		here := map[string]bool{}
		for _, req := range page.Requests {
			status := "-"
			if req.Status != nil {
				status = strconv.Itoa(*req.Status)
			}
			key := req.Method + "\x00" + req.URL + "\x00" + req.ResourceType + "\x00" + status
			if seen[key] {
				continue
			}
			here[key] = true
			out = append(out, req)
		}
		for k := range here {
			seen[k] = true
		}
	}
	return out
}

// CrawlArtefactIDs is every artefact the whole crawl found.
//
// Only the cross-page tracks use this. The api and security cases stand on a
// request the browser was seen to make, and which page it was made from is not
// part of the claim; the functional, ui and performance cases are statements
// about ONE page and are checked against that page's set alone.
func CrawlArtefactIDs(pages []Inventory, factIDs []string) map[string]bool {
	out := map[string]bool{}
	for _, page := range pages {
		for id := range ArtefactIDs(page, nil) {
			out[id] = true
		}
	}
	for _, id := range factIDs {
		out["fact:"+id] = true
	}
	return out
}

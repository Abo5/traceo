// environment.go — DERIVE A RUNNABLE ENVIRONMENT FROM AN IMPORTED DOCUMENT
// (fixed contract "derive a runnable environment from an imported document").
//
// The base URL is already stated by every document we accept: a Postman
// {{baseUrl}} variable, an Insomnia environment, a HAR capture's origin, an
// OpenAPI `servers` entry. Making the user retype it is a product bug, so the
// deterministic conversion also derives it — NO LLM, nothing invented.
//
// THE INVARIANT: `base_url + endpoint path` must reconstruct the original URL
// exactly. Endpoint paths are stored server-relative, with ONLY the origin (or
// the leading base-url variable) stripped, so the derived base URL carries
// exactly what was stripped and nothing more:
//
//	{{baseUrl}}/calendars/{calendarId}  ->  base "https://www.googleapis.com/calendar/v3"
//	                                        path "/calendars/{calendarId}"
//
// That is why the most-frequent fallback derives the ORIGIN only: nothing beyond
// scheme://host was ever removed from those paths, so appending a "common path
// prefix" on top would double it and break reconstruction.
//
// If no base URL can be derived, nothing is derived — a host is NEVER invented.
package collections

import (
	"sort"
	"strings"
)

// EnvironmentDraft is the deterministic environment derived from a document.
// An empty BaseURL means "nothing could be derived" — the caller creates nothing.
type EnvironmentDraft struct {
	// BaseURL has no trailing slash, always states scheme://host, and contains
	// no unresolved template placeholder.
	BaseURL string
	// Variables are the document's other variables with their example values,
	// credential-looking names carried with an EMPTY value.
	Variables map[string]any
}

// baseURLVariableNames is the ordered preference list of variable names that
// commonly hold the base URL (compared case-insensitively). The list is a
// PREFERENCE order: the first name that resolves to a usable base URL wins.
var baseURLVariableNames = []string{"baseurl", "base_url", "url", "host"}

// credentialNameParts — a variable whose name contains any of these (case
// insensitive substring) is a credential. Its value is never copied and never
// logged; the key is carried with an empty value so the user fills it in.
var credentialNameParts = []string{
	"token", "secret", "key", "password", "auth", "bearer", "apikey",
}

// IsCredentialName reports whether a variable name looks like a credential.
func IsCredentialName(name string) bool {
	lowered := strings.ToLower(name)
	for _, part := range credentialNameParts {
		if strings.Contains(lowered, part) {
			return true
		}
	}
	return false
}

// DeriveEnvironment derives the base URL and the suggested variables from a
// parsed document. `format` is one of the collection ids or "openapi3" /
// "swagger2" — every format the api-specs route accepts.
func DeriveEnvironment(format string, root map[string]any) EnvironmentDraft {
	if root == nil {
		return EnvironmentDraft{Variables: map[string]any{}}
	}
	switch format {
	case FormatPostman2:
		vars := postmanVariables(root["variable"])
		return draftFromVariables(vars, func() string {
			return mostFrequentOrigin(postmanOrigins(root, vars))
		})
	case FormatInsomnia4:
		vars := insomniaVariables(asList(root["resources"]))
		return draftFromVariables(vars, func() string {
			return mostFrequentOrigin(insomniaOrigins(root, vars))
		})
	case FormatHAR:
		// A capture states no variables — only the origin it was captured from.
		return EnvironmentDraft{BaseURL: mostFrequentOrigin(harOrigins(root)),
			Variables: map[string]any{}}
	case "openapi3":
		return EnvironmentDraft{BaseURL: openAPIServerURL(root),
			Variables: map[string]any{}}
	case "swagger2":
		return EnvironmentDraft{BaseURL: swaggerServerURL(root),
			Variables: map[string]any{}}
	}
	return EnvironmentDraft{Variables: map[string]any{}}
}

// draftFromVariables applies the shared rule for the two variable-carrying
// formats: the named base-url variable wins; otherwise the most frequent origin
// across the document's request URLs is used. Every OTHER variable becomes a
// suggested environment variable.
func draftFromVariables(vars map[string]string, fallback func() string) EnvironmentDraft {
	base, key := baseURLFromVariables(vars)
	if base == "" {
		base = fallback()
		key = "" // no variable was consumed, so none is excluded
	}
	return EnvironmentDraft{BaseURL: base, Variables: suggestedVariables(vars, key)}
}

// baseURLFromVariables returns the derived base URL and the variable name it
// came from. Names are matched case-insensitively in preference order; a name
// that matches but holds an unusable value (empty, still templated, or without a
// scheme://host) does not block the next candidate.
func baseURLFromVariables(vars map[string]string) (string, string) {
	names := make([]string, 0, len(vars))
	for name := range vars {
		names = append(names, name)
	}
	sort.Strings(names) // deterministic when a document defines two spellings
	for _, want := range baseURLVariableNames {
		for _, name := range names {
			if strings.ToLower(name) != want {
				continue
			}
			if base := normalizeBaseURL(vars[name]); base != "" {
				return base, name
			}
		}
	}
	return "", ""
}

// suggestedVariables copies every variable EXCEPT the one that became the base
// URL. A credential-looking name keeps its key with an EMPTY value: the user
// fills it in, and the document's live secret is never copied into the database
// nor into any response.
func suggestedVariables(vars map[string]string, baseURLKey string) map[string]any {
	out := map[string]any{}
	for name, value := range vars {
		if name == baseURLKey || strings.TrimSpace(name) == "" {
			continue
		}
		if IsCredentialName(name) {
			out[name] = ""
			continue
		}
		out[name] = value
	}
	return out
}

// normalizeBaseURL validates and tidies a candidate base URL. It must state a
// scheme://host and carry no unresolved placeholder — a value that does not is
// not runnable, and completing it would mean inventing a host. Any userinfo is
// dropped (a capture can carry credentials in the authority), as are the query
// and fragment, and the trailing slash so `base + "/path"` never doubles it.
func normalizeBaseURL(value string) string {
	v := strings.TrimSpace(value)
	if v == "" || strings.ContainsAny(v, "{}") {
		return ""
	}
	if i := strings.IndexAny(v, "?#"); i >= 0 {
		v = v[:i]
	}
	sep := strings.Index(v, "://")
	if sep <= 0 {
		return ""
	}
	scheme, rest := strings.ToLower(v[:sep]), v[sep+3:]
	authority, path := rest, ""
	if j := strings.Index(rest, "/"); j >= 0 {
		authority, path = rest[:j], rest[j:]
	}
	if at := strings.LastIndex(authority, "@"); at >= 0 {
		authority = authority[at+1:] // never carry userinfo into the environment
	}
	if authority == "" {
		return ""
	}
	path = strings.TrimRight(path, "/")
	return scheme + "://" + authority + path
}

// originOf extracts scheme://host[:port] from one raw request URL, resolving the
// document's variables first so a {{baseUrl}}-style URL still yields its origin.
func originOf(raw string, vars map[string]string) string {
	resolved := strings.TrimSpace(resolveVars(strings.TrimSpace(raw), vars))
	sep := strings.Index(resolved, "://")
	if sep <= 0 {
		return ""
	}
	scheme, rest := strings.ToLower(resolved[:sep]), resolved[sep+3:]
	if i := strings.IndexAny(rest, "/?#"); i >= 0 {
		rest = rest[:i]
	}
	if at := strings.LastIndex(rest, "@"); at >= 0 {
		rest = rest[at+1:]
	}
	if rest == "" || strings.ContainsAny(rest, "{}") {
		return ""
	}
	return scheme + "://" + rest
}

// mostFrequentOrigin picks the origin seen most often, ties broken by first
// appearance in the document — the same winner Python's Counter.most_common
// returns for an insertion-ordered count.
func mostFrequentOrigin(origins []string) string {
	counts := map[string]int{}
	order := []string{}
	for _, origin := range origins {
		if origin == "" {
			continue
		}
		if _, seen := counts[origin]; !seen {
			order = append(order, origin)
		}
		counts[origin]++
	}
	best, bestCount := "", 0
	for _, origin := range order {
		if counts[origin] > bestCount {
			best, bestCount = origin, counts[origin]
		}
	}
	return best
}

// --- per-format origin collection -------------------------------------------------

func postmanOrigins(root map[string]any, vars map[string]string) []string {
	out := []string{}
	var walk func(items []any)
	walk = func(items []any) {
		for _, entry := range items {
			item := asMap(entry)
			if item == nil {
				continue
			}
			if children, isFolder := item["item"]; isFolder {
				walk(asList(children))
				continue
			}
			switch request := item["request"].(type) {
			case string:
				out = append(out, originOf(request, vars))
			case map[string]any:
				out = append(out, originOf(postmanRawURL(request["url"]), vars))
			}
		}
	}
	walk(asList(root["item"]))
	return out
}

// postmanRawURL flattens a Postman url onto a raw string: url.raw when present,
// otherwise the protocol/host/port triple the v2 schema also allows.
func postmanRawURL(rawURL any) string {
	switch t := rawURL.(type) {
	case string:
		return t
	case map[string]any:
		if raw := strings.TrimSpace(str(t["raw"])); raw != "" {
			return raw
		}
		host := ""
		switch h := t["host"].(type) {
		case []any:
			parts := make([]string, 0, len(h))
			for _, p := range h {
				parts = append(parts, str(p))
			}
			host = strings.Join(parts, ".")
		case string:
			host = h
		}
		protocol := strings.TrimSpace(str(t["protocol"]))
		if host == "" || protocol == "" {
			return ""
		}
		if port := strings.TrimSpace(str(t["port"])); port != "" {
			host += ":" + port
		}
		return protocol + "://" + host
	}
	return ""
}

func insomniaOrigins(root map[string]any, vars map[string]string) []string {
	out := []string{}
	for _, entry := range asList(root["resources"]) {
		res := asMap(entry)
		if res == nil || str(res["_type"]) != "request" {
			continue
		}
		out = append(out, originOf(str(res["url"]), vars))
	}
	return out
}

func harOrigins(root map[string]any) []string {
	out := []string{}
	log := asMap(root["log"])
	if log == nil {
		return out
	}
	for _, entry := range asList(log["entries"]) {
		em := asMap(entry)
		if em == nil {
			continue
		}
		if request := asMap(em["request"]); request != nil {
			out = append(out, originOf(str(request["url"]), nil))
		}
	}
	return out
}

// --- OpenAPI / Swagger ------------------------------------------------------------

// openAPIServerURL derives the base URL from servers[0].url. Server variables
// are substituted from their DECLARED defaults (the document states them); a
// placeholder with no default leaves the URL unusable, so nothing is derived.
func openAPIServerURL(root map[string]any) string {
	servers := asList(root["servers"])
	if len(servers) == 0 {
		return ""
	}
	first := asMap(servers[0])
	if first == nil {
		return ""
	}
	raw := strings.TrimSpace(str(first["url"]))
	if raw == "" {
		return ""
	}
	for name, spec := range asMap(first["variables"]) {
		def := strings.TrimSpace(str(asMap(spec)["default"]))
		if def == "" {
			continue
		}
		raw = strings.ReplaceAll(raw, "{"+name+"}", def)
	}
	return normalizeBaseURL(raw)
}

// swaggerServerURL rebuilds the base URL from schemes + host + basePath. https
// is preferred when the document offers it; with no scheme stated there is
// nothing to build a runnable URL from, so nothing is derived.
func swaggerServerURL(root map[string]any) string {
	host := strings.TrimSpace(str(root["host"]))
	if host == "" {
		return ""
	}
	scheme := ""
	for _, entry := range asList(root["schemes"]) {
		candidate := strings.ToLower(strings.TrimSpace(str(entry)))
		if candidate == "" {
			continue
		}
		if candidate == "https" {
			scheme = candidate
			break
		}
		if scheme == "" {
			scheme = candidate
		}
	}
	if scheme == "" {
		return ""
	}
	basePath := strings.TrimSpace(str(root["basePath"]))
	if basePath != "" && !strings.HasPrefix(basePath, "/") {
		basePath = "/" + basePath
	}
	return normalizeBaseURL(scheme + "://" + host + basePath)
}

// --- environment naming ------------------------------------------------------------

// EnvironmentNameLimit is the Environment.name column limit both backends
// enforce (see the projects module's create handler).
const EnvironmentNameLimit = 100

// FallbackEnvironmentName is used when the document states no title.
const FallbackEnvironmentName = "Imported environment"

// EnvironmentName builds "<document title> (imported)", clipped to the column
// limit, falling back to FallbackEnvironmentName for a title-less document.
func EnvironmentName(title string) string {
	trimmed := strings.TrimSpace(title)
	if trimmed == "" {
		return FallbackEnvironmentName
	}
	return clip(trimmed+" (imported)", EnvironmentNameLimit)
}

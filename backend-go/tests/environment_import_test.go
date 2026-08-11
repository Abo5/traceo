// environment_import_test.go — quality gate for the fixed contract
// "derive a runnable environment from an imported document".
//
// The owner's complaint is the spec: "I only added a Postman collection for the
// API connection" and the New run screen still had an empty Environment picker.
// The base URL is IN the document, so importing it must leave the project
// runnable — without inventing a host and without ever copying a credential.
//
// Everything here runs offline against the same real 300KB Postman v2.1 export
// the collection gate uses (its collection variables are
// baseUrl="https://www.googleapis.com/calendar/v3" and calendarId="testCalendarID").
package tests_test

import (
	"encoding/json"
	"strings"
	"testing"

	"traceo/internal/modules/collections"
)

// --- helpers -------------------------------------------------------------------------

// environmentCreated returns the response's environment_created object, or nil.
func environmentCreated(t *testing.T, res M) M {
	t.Helper()
	value, present := res["environment_created"]
	if !present {
		t.Fatalf("response is missing the environment_created key: %v", res)
	}
	if value == nil {
		return nil
	}
	created, isMap := value.(M)
	if !isMap {
		t.Fatalf("environment_created must be null or an object, got %#v", value)
	}
	for _, key := range []string{"id", "name", "base_url"} {
		if str(created[key]) == "" {
			t.Fatalf("environment_created.%s is missing: %v", key, created)
		}
	}
	if len(created) != 3 {
		t.Fatalf("environment_created must carry exactly {id, name, base_url}: %v", created)
	}
	return created
}

func listEnvironments(t *testing.T, headers map[string]string, projectID string) []M {
	t.Helper()
	w := do(t, "GET", "/v1/projects/"+projectID+"/environments", nil, headers)
	if w.Code != 200 {
		t.Fatalf("list environments failed: %d %.300s", w.Code, w.Body.String())
	}
	out := []M{}
	for _, entry := range itemsOf(jsonAny(t, w)) {
		if row, isMap := entry.(M); isMap {
			out = append(out, row)
		}
	}
	return out
}

func onlyEnvironment(t *testing.T, headers map[string]string, projectID string) M {
	t.Helper()
	envs := listEnvironments(t, headers, projectID)
	if len(envs) != 1 {
		t.Fatalf("expected exactly 1 environment, got %d: %v", len(envs), envs)
	}
	return envs[0]
}

// auditEntry returns the first audit entry with the given action, or nil.
func auditEntry(t *testing.T, headers map[string]string, action string) M {
	t.Helper()
	w := do(t, "GET", "/v1/audit?limit=200", nil, headers)
	if w.Code != 200 {
		t.Fatalf("audit list failed: %d %.300s", w.Code, w.Body.String())
	}
	for _, entry := range itemsOf(jsonAny(t, w)) {
		if row, isMap := entry.(M); isMap && row["action"] == action {
			return row
		}
	}
	return nil
}

// --- 1. Postman: the reported bug, fixed ------------------------------------------------

func TestPostmanImportDerivesRunnableEnvironment(t *testing.T) {
	headers := registerOrg(t, "Env Derivation Org")
	projectID := createProject(t, headers, "Calendar Env") // manual: enrichment off

	res := importCollection(t, headers, projectID, "calendar-api.postman_collection.json",
		postmanFixture(t))

	created := environmentCreated(t, res)
	// The collection variable IS the base URL — including the /calendar/v3 prefix,
	// without which no stored path could be reconstructed.
	if created["base_url"] != "https://www.googleapis.com/calendar/v3" {
		t.Fatalf("baseUrl collection variable was not used verbatim: %v", created["base_url"])
	}
	if created["name"] != "🗓️ Calendar API (imported)" {
		t.Fatalf("environment name should come from the document title: %v", created["name"])
	}

	env := onlyEnvironment(t, headers, projectID)
	if env["id"] != created["id"] {
		t.Fatalf("environment_created.id does not identify the created row: %v vs %v",
			created["id"], env["id"])
	}
	if env["base_url"] != created["base_url"] || env["name"] != created["name"] {
		t.Fatalf("environment_created must mirror the stored row: %v vs %v", created, env)
	}
	if env["auth_type"] != "none" {
		t.Fatalf("auth_type must be none — the document states no credentials: %v", env["auth_type"])
	}
	if env["tls_strict"] != true {
		t.Fatalf("tls_strict must default to true: %v", env["tls_strict"])
	}
	if env["auth_config_masked"] != false {
		t.Fatalf("no auth config may be set: %v", env["auth_config_masked"])
	}

	// The OTHER collection variable becomes a suggested variable; the base-url one
	// does not (it is the base_url now, not a variable).
	vars, _ := env["variables"].(M)
	if len(vars) != 1 || vars["calendarId"] != "testCalendarID" {
		t.Fatalf("suggested variables should be exactly the non-base-url variables: %v", vars)
	}

	// THE INVARIANT: base_url + endpoint path reconstructs the original URL.
	rows := listEndpointsByKey(t, headers, projectID)
	acl, present := rows["GET /calendars/{calendarId}/acl"]
	if !present {
		t.Fatalf("expected endpoint missing: %v", sortedRowKeys(rows))
	}
	reconstructed := str(created["base_url"]) + str(acl["path"])
	if reconstructed != "https://www.googleapis.com/calendar/v3/calendars/{calendarId}/acl" {
		t.Fatalf("base_url + path does not reconstruct the original URL: %q", reconstructed)
	}

	// A re-import fills no void — the environment already exists, so nothing is
	// created and the existing row is left completely alone.
	again := importCollection(t, headers, projectID, "calendar-api.postman_collection.json",
		postmanFixture(t))
	if got := environmentCreated(t, again); got != nil {
		t.Fatalf("a second import must not create another environment: %v", got)
	}
	after := onlyEnvironment(t, headers, projectID)
	if after["id"] != env["id"] || after["updated_at"] != env["updated_at"] {
		t.Fatalf("the existing environment was modified by the re-import: %v vs %v", env, after)
	}
}

// TestAutocreatedEnvironmentIsAudited pins the audit detail key for key against
// the Python reference backend: an unexplained environment appearing in a
// project has to be answerable ("where did this come from?"), and the answer is
// the source format plus the derived URL and the variable NAMES — never a value.
func TestAutocreatedEnvironmentIsAudited(t *testing.T) {
	headers := registerOrg(t, "Env Audit Org")
	projectID := createProject(t, headers, "Audited Env")

	res := importCollection(t, headers, projectID, "calendar-api.postman_collection.json",
		postmanFixture(t))
	created := environmentCreated(t, res)

	entry := auditEntry(t, headers, "environment.autocreated")
	if entry == nil {
		t.Fatalf("the auto-created environment was not audited")
	}
	if entry["object_type"] != "environment" || entry["object_id"] != created["id"] {
		t.Fatalf("audit entry does not identify the created environment: %v", entry)
	}
	detail, _ := entry["detail"].(M)
	if detail["format"] != "postman2" {
		t.Fatalf("the source format must be recorded: %v", detail)
	}
	if detail["base_url"] != "https://www.googleapis.com/calendar/v3" {
		t.Fatalf("the derived base URL must be recorded: %v", detail)
	}
	if detail["name"] != created["name"] || detail["auth_type"] != "none" ||
		detail["auth_config_set"] != false {
		t.Fatalf("audit detail diverges from the environment write path: %v", detail)
	}
	names, _ := detail["variables"].([]any)
	if len(names) != 1 || names[0] != "calendarId" {
		t.Fatalf("variable NAMES must be recorded: %v", detail["variables"])
	}
	// names only — a variable value must never reach the audit trail
	if raw, _ := json.Marshal(detail); strings.Contains(string(raw), "testCalendarID") {
		t.Fatalf("a variable value leaked into the audit detail: %s", raw)
	}
}

// --- 2. An existing environment is never touched -----------------------------------------

func TestImportNeverTouchesAnExistingEnvironment(t *testing.T) {
	headers := registerOrg(t, "Existing Env Org")
	projectID := createProject(t, headers, "Has Env")

	w := do(t, "POST", "/v1/projects/"+projectID+"/environments",
		M{"name": "staging", "base_url": "https://staging.internal.example",
			"variables": M{"calendarId": "mine"}}, headers)
	if w.Code != 201 && w.Code != 200 {
		t.Fatalf("create environment failed: %d %.300s", w.Code, w.Body.String())
	}
	before := onlyEnvironment(t, headers, projectID)

	res := importCollection(t, headers, projectID, "calendar-api.postman_collection.json",
		postmanFixture(t))
	if got := environmentCreated(t, res); got != nil {
		t.Fatalf("auto-creation must only ever fill a void: %v", got)
	}
	after := onlyEnvironment(t, headers, projectID)
	if after["id"] != before["id"] || after["name"] != "staging" ||
		after["base_url"] != "https://staging.internal.example" {
		t.Fatalf("the user's environment was overwritten: %v -> %v", before, after)
	}
	if vars, _ := after["variables"].(M); vars["calendarId"] != "mine" {
		t.Fatalf("the user's variables were overwritten: %v", after["variables"])
	}
	// ... and the import itself still worked.
	if num(t, res, "total") != 37 {
		t.Fatalf("the import must be unaffected: %v", res["total"])
	}
}

// --- 3. HAR: most frequent origin ---------------------------------------------------------

func TestHARImportDerivesTheMostFrequentOrigin(t *testing.T) {
	headers := registerOrg(t, "HAR Env Org")
	projectID := createProject(t, headers, "HAR Env")

	res := importCollection(t, headers, projectID, "capture.har", []byte(harFixture))
	created := environmentCreated(t, res)
	if created["base_url"] != "https://api.example.com" {
		t.Fatalf("HAR origin not derived: %v", created["base_url"])
	}
	// The HAR creator names the document (the tool NAME, not its build version —
	// the Python reference backend returns exactly this); a capture declares no
	// variables.
	if created["name"] != "Traceo Proxy (imported)" {
		t.Fatalf("unexpected environment name: %v", created["name"])
	}
	env := onlyEnvironment(t, headers, projectID)
	if vars, _ := env["variables"].(M); len(vars) != 0 {
		t.Fatalf("a capture states no variables: %v", vars)
	}
	// origin + stored path reconstructs the captured URL
	rows := listEndpointsByKey(t, headers, projectID)
	orders := rows["GET /v1/users/{id}/orders/{id2}"]
	if orders == nil {
		t.Fatalf("expected endpoint missing: %v", sortedRowKeys(rows))
	}
	if got := str(created["base_url"]) + str(orders["path"]); got !=
		"https://api.example.com/v1/users/{id}/orders/{id2}" {
		t.Fatalf("base_url + path does not reconstruct the capture: %q", got)
	}
}

// --- 4. Insomnia: environment data variable ------------------------------------------------

func TestInsomniaImportDerivesEnvironmentBaseURL(t *testing.T) {
	headers := registerOrg(t, "Insomnia Env Org")
	projectID := createProject(t, headers, "Insomnia Env")

	res := importCollection(t, headers, projectID, "export.json", []byte(insomniaFixture))
	created := environmentCreated(t, res)
	if created["base_url"] != "https://api.example.com" {
		t.Fatalf("Insomnia environment baseUrl not derived: %v", created["base_url"])
	}
	// The workspace resource names an Insomnia export; __export_source names the
	// exporting APPLICATION and must never become the environment's name.
	if created["name"] != "Billing (imported)" {
		t.Fatalf("unexpected environment name: %v", created["name"])
	}
	env := onlyEnvironment(t, headers, projectID)
	if vars, _ := env["variables"].(M); len(vars) != 0 {
		t.Fatalf("baseUrl was the only variable and became base_url: %v", vars)
	}
}

// --- 5. Credentials are NEVER copied --------------------------------------------------------

const credentialVarsCollection = `{
 "info":{"name":"Secrets API",
   "schema":"https://schema.getpostman.com/json/collection/v2.1.0/collection.json"},
 "variable":[
   {"key":"baseUrl","value":"https://api.example.com/v1"},
   {"key":"tenant","value":"acme"},
   {"key":"authToken","value":"LIVE-TOKEN-MUST-NEVER-BE-COPIED"},
   {"key":"api_key","value":"LIVE-KEY-MUST-NEVER-BE-COPIED"},
   {"key":"PASSWORD","value":"LIVE-PASSWORD-MUST-NEVER-BE-COPIED"},
   {"key":"clientSecret","value":"LIVE-SECRET-MUST-NEVER-BE-COPIED"},
   {"key":"bearerValue","value":"LIVE-BEARER-MUST-NEVER-BE-COPIED"}
 ],
 "item":[{"name":"List things","request":{"method":"GET",
   "url":{"raw":"{{baseUrl}}/things","host":["{{baseUrl}}"],"path":["things"]}}}]
}`

func TestCredentialVariablesAreCarriedWithEmptyValues(t *testing.T) {
	headers := registerOrg(t, "Credential Vars Org")
	projectID := createProject(t, headers, "Credential Vars")

	w := uploadFile(t, "/v1/projects/"+projectID+"/api-specs", "secrets.postman_collection.json",
		[]byte(credentialVarsCollection), "application/json", headers)
	if w.Code != 200 && w.Code != 201 {
		t.Fatalf("import failed: %d %.300s", w.Code, w.Body.String())
	}
	body := w.Body.String()
	res := jsonMap(t, w)

	created := environmentCreated(t, res)
	if created["base_url"] != "https://api.example.com/v1" {
		t.Fatalf("base URL not derived: %v", created["base_url"])
	}

	env := onlyEnvironment(t, headers, projectID)
	vars, _ := env["variables"].(M)
	if vars["tenant"] != "acme" {
		t.Fatalf("a plain variable must keep its example value: %v", vars)
	}
	for _, name := range []string{"authToken", "api_key", "PASSWORD", "clientSecret",
		"bearerValue"} {
		value, present := vars[name]
		if !present {
			t.Fatalf("credential variable %q must still be listed for the user to fill: %v",
				name, vars)
		}
		if value != "" {
			t.Fatalf("credential variable %q leaked its value: %v", name, value)
		}
	}
	if len(vars) != 6 {
		t.Fatalf("expected the 6 non-base-url variables: %v", vars)
	}
	// Not in the import response, and not in the environments payload either.
	envJSON, _ := json.Marshal(listEnvironments(t, headers, projectID))
	for _, haystack := range []string{body, string(envJSON)} {
		if strings.Contains(haystack, "MUST-NEVER-BE-COPIED") {
			t.Fatalf("a live credential value was disclosed: %.400s", haystack)
		}
	}
}

// --- 6. OpenAPI / Swagger --------------------------------------------------------------------

func TestOpenAPIServersDeriveTheEnvironment(t *testing.T) {
	headers := registerOrg(t, "OpenAPI Env Org")
	projectID := createProject(t, headers, "OpenAPI Env")

	spec, _ := json.Marshal(M{
		"openapi": "3.0.3",
		"info":    M{"title": "Customers API", "version": "1.0.0"},
		"servers": []M{{"url": "https://{host}/api/v3/",
			"variables": M{"host": M{"default": "api.example.com"}}},
			{"url": "https://sandbox.example.com"}},
		"paths": M{"/customers": M{"get": M{"operationId": "listCustomers",
			"responses": M{"200": M{"description": "OK"}}}}},
	})
	res := importCollection(t, headers, projectID, "spec.json", spec)
	if res["format"] != "openapi3" {
		t.Fatalf("OpenAPI detection regressed: %v", res["format"])
	}
	created := environmentCreated(t, res)
	// servers[0] wins, its declared default is substituted, the trailing slash is
	// dropped so base_url + "/customers" reconstructs the URL exactly once.
	if created["base_url"] != "https://api.example.com/api/v3" {
		t.Fatalf("servers[0].url not derived: %v", created["base_url"])
	}
	if created["name"] != "Customers API (imported)" {
		t.Fatalf("unexpected environment name: %v", created["name"])
	}
}

func TestSpecWithoutAServerDerivesNothing(t *testing.T) {
	headers := registerOrg(t, "No Server Org")
	projectID := createProject(t, headers, "No Server")

	// The shared fixture declares no `servers` — a host must never be invented.
	res := importSpec(t, headers, projectID)
	if got := environmentCreated(t, res); got != nil {
		t.Fatalf("a spec without servers must derive nothing, got %v", got)
	}
	if envs := listEnvironments(t, headers, projectID); len(envs) != 0 {
		t.Fatalf("no environment may be created: %v", envs)
	}
	// The import itself is untouched.
	if num(t, res, "endpoints_count") != 2 {
		t.Fatalf("existing import behaviour changed: %v", res)
	}
}

func TestSwagger2HostAndBasePathDeriveTheEnvironment(t *testing.T) {
	headers := registerOrg(t, "Swagger Env Org")
	projectID := createProject(t, headers, "Swagger Env")

	spec, _ := json.Marshal(M{
		"swagger":  "2.0",
		"info":     M{"title": "Legacy API", "version": "1.0.0"},
		"schemes":  []string{"http", "https"},
		"host":     "legacy.example.com",
		"basePath": "/v2",
		"paths": M{"/pets": M{"get": M{"operationId": "listPets",
			"responses": M{"200": M{"description": "OK"}}}}},
	})
	res := importCollection(t, headers, projectID, "swagger.json", spec)
	if res["format"] != "swagger2" {
		t.Fatalf("Swagger detection regressed: %v", res["format"])
	}
	created := environmentCreated(t, res)
	// https is preferred when offered; basePath is part of what the paths omit.
	if created["base_url"] != "https://legacy.example.com/v2" {
		t.Fatalf("schemes+host+basePath not derived: %v", created["base_url"])
	}
}

// --- 7. Derivation rules, unit level ------------------------------------------------------------

func parseDoc(t *testing.T, raw string) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		t.Fatalf("fixture is not JSON: %v", err)
	}
	return out
}

func TestDeriveEnvironmentFallsBackToTheMostFrequentOrigin(t *testing.T) {
	// No base-url variable anywhere: two requests on api.example.com, one on
	// other.example.com — the majority origin wins, and nothing beyond the origin
	// is added, because nothing beyond the origin was stripped from the paths.
	doc := parseDoc(t, `{
	 "info":{"name":"Mixed","schema":"https://schema.getpostman.com/json/collection/v2.1.0/collection.json"},
	 "variable":[{"key":"tenant","value":"acme"}],
	 "item":[
	  {"name":"a","request":{"method":"GET","url":{"raw":"https://api.example.com/v1/a"}}},
	  {"name":"b","request":{"method":"GET","url":{"raw":"https://other.example.com/v1/b"}}},
	  {"name":"c","request":{"method":"GET","url":{"raw":"https://api.example.com/v1/c"}}}
	 ]}`)
	draft := collections.DeriveEnvironment(collections.FormatPostman2, doc)
	if draft.BaseURL != "https://api.example.com" {
		t.Fatalf("most frequent origin not chosen: %q", draft.BaseURL)
	}
	if len(draft.Variables) != 1 || draft.Variables["tenant"] != "acme" {
		t.Fatalf("variables should survive the fallback: %v", draft.Variables)
	}
}

func TestDeriveEnvironmentNeverInventsAHost(t *testing.T) {
	cases := map[string]string{
		"no origin anywhere": `{
		 "info":{"name":"Rel","schema":"https://schema.getpostman.com/json/collection/v2.1.0/collection.json"},
		 "item":[{"name":"a","request":{"method":"GET","url":{"raw":"/v1/a"}}}]}`,
		"unresolved base-url variable": `{
		 "info":{"name":"Tpl","schema":"https://schema.getpostman.com/json/collection/v2.1.0/collection.json"},
		 "variable":[{"key":"baseUrl","value":"{{env}}"}],
		 "item":[{"name":"a","request":{"method":"GET","url":{"raw":"{{baseUrl}}/a"}}}]}`,
		"host without a scheme": `{
		 "info":{"name":"Bare","schema":"https://schema.getpostman.com/json/collection/v2.1.0/collection.json"},
		 "variable":[{"key":"baseUrl","value":"api.example.com"}],
		 "item":[{"name":"a","request":{"method":"GET","url":{"raw":"{{baseUrl}}/a"}}}]}`,
	}
	for name, raw := range cases {
		draft := collections.DeriveEnvironment(collections.FormatPostman2, parseDoc(t, raw))
		if draft.BaseURL != "" {
			t.Fatalf("%s: derived %q instead of nothing", name, draft.BaseURL)
		}
	}
}

func TestDeriveEnvironmentVariableNamePrecedenceAndCredentialFilter(t *testing.T) {
	doc := parseDoc(t, `{
	 "info":{"name":"Precedence","schema":"https://schema.getpostman.com/json/collection/v2.1.0/collection.json"},
	 "variable":[
	   {"key":"host","value":"https://last.example.com"},
	   {"key":"url","value":"https://third.example.com"},
	   {"key":"BASE_URL","value":"https://second.example.com"},
	   {"key":"baseurl","value":"https://first.example.com/api"}
	 ],
	 "item":[{"name":"a","request":{"method":"GET","url":{"raw":"{{baseurl}}/a"}}}]}`)
	draft := collections.DeriveEnvironment(collections.FormatPostman2, doc)
	if draft.BaseURL != "https://first.example.com/api" {
		t.Fatalf("baseUrl must win over base_url/url/host: %q", draft.BaseURL)
	}
	// Only the variable that BECAME the base url is dropped from the map.
	if len(draft.Variables) != 3 {
		t.Fatalf("the other candidates stay as variables: %v", draft.Variables)
	}
	if _, present := draft.Variables["baseurl"]; present {
		t.Fatalf("the base-url variable must not be duplicated as a variable: %v", draft.Variables)
	}

	for _, name := range []string{"token", "API_KEY", "apikey", "clientSecret", "myPassword",
		"Authorization", "bearer", "x-api-key"} {
		if !collections.IsCredentialName(name) {
			t.Fatalf("%q must be treated as a credential name", name)
		}
	}
	for _, name := range []string{"tenant", "calendarId", "userId", "region", "locale"} {
		if collections.IsCredentialName(name) {
			t.Fatalf("%q is not a credential name", name)
		}
	}
}

func TestDeriveEnvironmentDropsUserinfoAndTrailingSlash(t *testing.T) {
	doc := parseDoc(t, `{"log":{"version":"1.2","entries":[
	 {"request":{"method":"GET","url":"https://user:pa55@api.example.com/v1/a/"}},
	 {"request":{"method":"GET","url":"https://user:pa55@api.example.com/v1/b"}}
	]}}`)
	draft := collections.DeriveEnvironment(collections.FormatHAR, doc)
	if draft.BaseURL != "https://api.example.com" {
		t.Fatalf("captured userinfo must never reach the environment: %q", draft.BaseURL)
	}
}

func TestEnvironmentNameFallsBackAndRespectsTheColumnLimit(t *testing.T) {
	if got := collections.EnvironmentName("   "); got != "Imported environment" {
		t.Fatalf("a title-less document must fall back: %q", got)
	}
	long := collections.EnvironmentName(strings.Repeat("é", 400))
	if len([]rune(long)) != collections.EnvironmentNameLimit {
		t.Fatalf("name must be clipped to the column limit, got %d runes", len([]rune(long)))
	}
}

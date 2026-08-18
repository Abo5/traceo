// collections_test.go — quality gate for the fixed contract
// "API collection import + AI enrichment".
//
// Everything runs offline against the deterministic mock provider (NFR-D1). The
// Postman gate uses a REAL 300KB Postman v2.1 export (37 requests, ":param" path
// segments, {{baseUrl}}/{{calendarId}} collection variables, 35 distinct query
// params, 19 raw JSON bodies, no auth block) checked in under tests/fixtures/.
package tests_test

import (
	"encoding/json"
	"os"
	"strings"
	"testing"

	"traceo/internal/db"
	"traceo/internal/llm"
	"traceo/internal/models"
	"traceo/internal/modules/collections"
)

// --- helpers -----------------------------------------------------------------------

// createAutoProject makes an automation:"auto" project — the gate for the
// optional enrichment step (contract item 3 reuses the existing flag).
func createAutoProject(t *testing.T, headers map[string]string, name string) string {
	t.Helper()
	w := do(t, "POST", "/v1/projects", M{"name": name, "automation": "auto"}, headers)
	if w.Code != 200 && w.Code != 201 {
		t.Fatalf("create project failed: %d %.300s", w.Code, w.Body.String())
	}
	data := jsonMap(t, w)
	id, _ := data["id"].(string)
	if id == "" {
		t.Fatalf("no project id: %.300s", w.Body.String())
	}
	return id
}

func postmanFixture(t *testing.T) []byte {
	t.Helper()
	raw, err := os.ReadFile("fixtures/calendar-api.postman_collection.json")
	if err != nil {
		t.Fatalf("read postman fixture: %v", err)
	}
	return raw
}

// importCollection uploads a document to the SAME api-specs route OpenAPI uses.
func importCollection(t *testing.T, headers map[string]string, projectID, filename string,
	content []byte) M {
	t.Helper()
	w := uploadFile(t, "/v1/projects/"+projectID+"/api-specs", filename, content,
		"application/json", headers)
	if w.Code != 200 && w.Code != 201 {
		t.Fatalf("collection import failed: %d %.400s", w.Code, w.Body.String())
	}
	return jsonMap(t, w)
}

func listEndpointsByKey(t *testing.T, headers map[string]string, projectID string) map[string]M {
	t.Helper()
	w := do(t, "GET", "/v1/projects/"+projectID+"/endpoints", nil, headers)
	if w.Code != 200 {
		t.Fatalf("list endpoints failed: %d %.300s", w.Code, w.Body.String())
	}
	out := map[string]M{}
	for _, entry := range itemsOf(jsonAny(t, w)) {
		row, _ := entry.(M)
		if row == nil {
			continue
		}
		out[strings.ToUpper(str(row["method"]))+" "+str(row["path"])] = row
	}
	return out
}

func str(v any) string {
	s, _ := v.(string)
	return s
}

func num(t *testing.T, payload M, key string) int {
	t.Helper()
	v, present := payload[key]
	if !present {
		t.Fatalf("response is missing key %q: %v", key, payload)
	}
	f, isNum := v.(float64)
	if !isNum {
		t.Fatalf("key %q is not a number: %v", key, v)
	}
	return int(f)
}

func paramsByName(row M) map[string]M {
	out := map[string]M{}
	list, _ := row["parameters"].([]any)
	for _, entry := range list {
		p, _ := entry.(M)
		if p == nil {
			continue
		}
		out[str(p["name"])] = p
	}
	return out
}

// --- 1. Postman v2.1: detection + deterministic conversion --------------------------

func TestPostmanCollectionImportsAndIsGrounded(t *testing.T) {
	headers := registerOrg(t, "Postman Import Org")
	projectID := createAutoProject(t, headers, "Calendar")

	res := importCollection(t, headers, projectID, "calendar-api.postman_collection.json",
		postmanFixture(t))

	if res["format"] != "postman2" {
		t.Fatalf("expected format postman2, got %v", res["format"])
	}
	if got := num(t, res, "endpoints_count"); got != 37 {
		t.Fatalf("expected 37 endpoints, got %d", got)
	}
	if got := num(t, res, "total"); got != 37 {
		t.Fatalf("expected total 37, got %d", got)
	}
	if got := num(t, res, "added"); got != 37 {
		t.Fatalf("expected added 37, got %d", got)
	}
	if got := num(t, res, "removed"); got != 0 {
		t.Fatalf("expected removed 0, got %d", got)
	}
	if got := num(t, res, "updated"); got != 0 {
		t.Fatalf("expected updated 0, got %d", got)
	}
	// existing keys keep their names and meanings
	diff, isMap := res["diff"].(M)
	if !isMap {
		t.Fatalf("diff missing from the response: %v", res)
	}
	if added, _ := diff["added"].([]any); len(added) != 37 {
		t.Fatalf("diff.added should list 37 keys, got %d", len(added))
	}

	rows := listEndpointsByKey(t, headers, projectID)
	if len(rows) != 37 {
		t.Fatalf("expected 37 persisted endpoints, got %d", len(rows))
	}
	for key, row := range rows {
		path := str(row["path"])
		if !strings.HasPrefix(path, "/") {
			t.Fatalf("path is not server-relative: %q", path)
		}
		if strings.Contains(path, "{{") || strings.Contains(path, "://") {
			t.Fatalf("unresolved variable or origin left in path: %q", path)
		}
		for _, seg := range strings.Split(path, "/") {
			if strings.HasPrefix(seg, ":") {
				t.Fatalf("Postman ':param' segment was not templated: %q", path)
			}
		}
		if row["source"] != "postman" {
			t.Fatalf("%s: expected source postman, got %v", key, row["source"])
		}
	}

	// ":calendarId" / ":ruleId" became "{calendarId}" / "{ruleId}" path params
	acl, present := rows["PATCH /calendars/{calendarId}/acl/{ruleId}"]
	if !present {
		t.Fatalf("templated acl-rule endpoint missing; got keys %v", sortedRowKeys(rows))
	}
	params := paramsByName(acl)
	for _, name := range []string{"calendarId", "ruleId"} {
		p, ok := params[name]
		if !ok {
			t.Fatalf("path param %q missing", name)
		}
		if p["location"] != "path" || p["required"] != true {
			t.Fatalf("path param %q should be a required path param: %v", name, p)
		}
	}
	// query params carry example values and inferred scalar types
	if p := params["sendNotifications"]; p == nil || p["location"] != "query" ||
		p["type"] != "boolean" {
		t.Fatalf("query param sendNotifications not captured correctly: %v", p)
	}
	// Headers are captured as header params and NEVER as query params, but the
	// pure-transport ones (Accept, Content-Type, User-Agent, ...) are dropped as
	// noise: they describe the transport, not the API contract, and would
	// otherwise appear on every endpoint in the inventory. This collection
	// carries no others, so it must contribute no header params at all.
	for _, name := range []string{"Content-Type", "Accept"} {
		if p, present := params[name]; present {
			t.Fatalf("transport header %q must not become a parameter: %v", name, p)
		}
	}
	for name, p := range params {
		if p["location"] == "query" && (name == "Content-Type" || name == "Accept") {
			t.Fatalf("header %q was treated as a query param", name)
		}
	}
	// raw JSON body -> inferred JSON Schema, no invented fields
	schema, _ := acl["request_schema"].(M)
	props, _ := schema["properties"].(M)
	if len(props) == 0 {
		t.Fatalf("request schema was not inferred: %v", schema)
	}
	for _, field := range []string{"etag", "id", "kind", "role", "scope"} {
		if _, present := props[field]; !present {
			t.Fatalf("body field %q missing from the inferred schema: %v", props, field)
		}
	}
	if len(props) != 5 {
		t.Fatalf("inferred schema invented fields: %v", props)
	}
	scope, _ := props["scope"].(M)
	if scope["type"] != "object" {
		t.Fatalf("nested object was not recursed: %v", scope)
	}
	// saved response examples -> observed status codes
	responses, _ := acl["response_schemas"].(M)
	if len(responses) == 0 {
		t.Fatalf("no response status codes recorded: %v", acl["response_schemas"])
	}

	// a query param whose example is numeric is typed integer
	list := rows["GET /calendars/{calendarId}/acl"]
	if list == nil {
		t.Fatal("acl list endpoint missing")
	}
	if p := paramsByName(list)["maxResults"]; p == nil || p["type"] != "integer" {
		t.Fatalf("maxResults should be typed integer from its example: %v", p)
	}

	// Re-importing the same file is a no-op diff (dedupe + stable upsert): the
	// inventory is unchanged, so nothing is added, removed or altered. `updated`
	// is 37 because the import re-writes all 37 rows it declares; `diff.changed`
	// staying empty is what proves the conversion is deterministic.
	again := importCollection(t, headers, projectID, "calendar-api.postman_collection.json",
		postmanFixture(t))
	if num(t, again, "added") != 0 || num(t, again, "removed") != 0 ||
		num(t, again, "total") != 37 || num(t, again, "updated") != 37 {
		t.Fatalf("re-import should be a no-op, got %v", again)
	}
	againDiff, _ := again["diff"].(M)
	if changed, _ := againDiff["changed"].([]any); len(changed) != 0 {
		t.Fatalf("re-importing the identical file changed endpoints: %v", changed)
	}
}

func sortedRowKeys(rows map[string]M) []string {
	keys := make([]string, 0, len(rows))
	for k := range rows {
		keys = append(keys, k)
	}
	return keys
}

// --- 2. AI enrichment: gated, validated, additive ------------------------------------

func TestCollectionImportEnrichesUnderAutomationAuto(t *testing.T) {
	headers := registerOrg(t, "Enrichment Org")
	projectID := createAutoProject(t, headers, "Calendar Auto")

	res := importCollection(t, headers, projectID, "calendar.postman_collection.json",
		postmanFixture(t))
	if got := num(t, res, "enriched"); got != 37 {
		t.Fatalf("expected 37 enriched endpoints, got %d", got)
	}
	if got := num(t, res, "enrichment_discarded"); got != 0 {
		t.Fatalf("the deterministic mock must not produce discards, got %d", got)
	}

	rows := listEndpointsByKey(t, headers, projectID)
	for key, row := range rows {
		desc := str(row["ai_description"])
		if desc == "" {
			t.Fatalf("%s: ai_description not persisted", key)
		}
		if str(row["ai_group"]) == "" {
			t.Fatalf("%s: ai_group not persisted", key)
		}
		switch row["ai_criticality"] {
		case "high", "medium", "low":
		default:
			t.Fatalf("%s: illegal ai_criticality %v", key, row["ai_criticality"])
		}
	}
	// enrichment is descriptive only — it never renamed or invented an endpoint
	if len(rows) != 37 {
		t.Fatalf("enrichment changed the inventory size: %d", len(rows))
	}
	if _, present := rows["DELETE /calendars/{calendarId}"]; !present {
		t.Fatal("deterministic endpoint disappeared after enrichment")
	}
	if rows["DELETE /calendars/{calendarId}"]["ai_criticality"] != "high" {
		t.Fatalf("mock criticality rule changed: %v",
			rows["DELETE /calendars/{calendarId}"]["ai_criticality"])
	}
}

func TestCollectionImportSkipsEnrichmentUnderAutomationManual(t *testing.T) {
	headers := registerOrg(t, "Manual Enrichment Org")
	projectID := createProject(t, headers, "Calendar Manual") // automation: manual

	res := importCollection(t, headers, projectID, "calendar.postman_collection.json",
		postmanFixture(t))
	if got := num(t, res, "enriched"); got != 0 {
		t.Fatalf("manual automation must not enrich, got %d", got)
	}
	if got := num(t, res, "enrichment_discarded"); got != 0 {
		t.Fatalf("expected zero discards, got %d", got)
	}
	if got := num(t, res, "total"); got != 37 {
		t.Fatalf("the import itself must still succeed with 37 endpoints, got %d", got)
	}
	for key, row := range listEndpointsByKey(t, headers, projectID) {
		if row["ai_description"] != nil || row["ai_group"] != nil ||
			row["ai_criticality"] != nil {
			t.Fatalf("%s: ai_* must stay null without enrichment: %v", key, row)
		}
	}
}

// --- 3. THE GATE: adversarial enrichment output --------------------------------------

func TestEnrichmentValidationGateDiscardsAdversarialItems(t *testing.T) {
	inventory := []collections.Operation{{
		Method: "GET", Path: "/customers/{id}",
		Parameters: []map[string]any{{"name": "id", "location": "path",
			"type": "string", "required": true, "constraints": map[string]any{}}},
		RequestSchema:   map[string]any{"type": "object", "properties": map[string]any{"name": map[string]any{"type": "string"}}},
		ResponseSchemas: map[string]any{},
	}}

	items := []any{
		// legitimate
		map[string]any{"method": "get", "path": "/customers/{id}",
			"description": "Read one customer.", "group": "customers", "criticality": "LOW"},
		// fabricated endpoint
		map[string]any{"method": "GET", "path": "/admin/secrets",
			"description": "Dump secrets.", "group": "admin", "criticality": "high"},
		// real path, wrong method
		map[string]any{"method": "DELETE", "path": "/customers/{id}",
			"description": "Delete a customer.", "criticality": "high"},
		// renamed path (a single character off)
		map[string]any{"method": "GET", "path": "/customers/{customerId}",
			"description": "Renamed path.", "criticality": "low"},
		// references a parameter that does not exist
		map[string]any{"method": "GET", "path": "/customers/{id}",
			"params": []any{"id", "ssn"}, "description": "Leaky.", "criticality": "low"},
		// duplicate of an already-accepted endpoint
		map[string]any{"method": "GET", "path": "/customers/{id}",
			"description": "Second opinion.", "criticality": "high"},
		// nothing usable
		map[string]any{"method": "GET", "path": "/customers/{id}"},
		// not even an object
		"GET /customers/{id}",
	}

	var result collections.EnrichResult
	collections.ValidateEnrichment(inventory, items, &result)

	if result.Enriched != 1 {
		t.Fatalf("exactly one item should survive the gate, got %d", result.Enriched)
	}
	if result.Discarded != 7 {
		t.Fatalf("expected 7 discards, got %d", result.Discarded)
	}
	accepted, present := result.ByKey["GET /customers/{id}"]
	if !present {
		t.Fatal("the legitimate item was not accepted")
	}
	if accepted.Description != "Read one customer." || accepted.Criticality != "low" {
		t.Fatalf("accepted item was not normalized: %+v", accepted)
	}
	if _, leaked := result.ByKey["GET /admin/secrets"]; leaked {
		t.Fatal("a fabricated endpoint leaked through the gate")
	}

	// Markup and control characters are stripped — enrichment is plain text only.
	// The criticality here is LEGAL on purpose: an item with an illegal one is
	// discarded outright (asserted below), which would make these assertions pass
	// against an empty struct and prove nothing.
	var sanitized collections.EnrichResult
	collections.ValidateEnrichment(inventory, []any{map[string]any{
		"method": "GET", "path": "/customers/{id}",
		"description": "<script>alert(1)</script>\x00  spaced\tout",
		"group":       "<b>customers</b>", "criticality": "low",
	}}, &sanitized)
	got, kept := sanitized.ByKey["GET /customers/{id}"]
	if !kept {
		t.Fatal("a legitimate item was discarded by the sanitizer")
	}
	if strings.ContainsAny(got.Description, "<>\x00\t") ||
		strings.Contains(got.Description, "  ") {
		t.Fatalf("description was not sanitized: %q", got.Description)
	}
	if strings.ContainsAny(got.Group, "<>") {
		t.Fatalf("group was not sanitized: %q", got.Group)
	}

	// An out-of-vocabulary criticality is not "silently blank" — the whole item is
	// unverified, so it is discarded and counted. Same bar as the Python gate.
	var illegal collections.EnrichResult
	collections.ValidateEnrichment(inventory, []any{map[string]any{
		"method": "GET", "path": "/customers/{id}",
		"description": "Read one customer.", "group": "customers",
		"criticality": "nuclear",
	}}, &illegal)
	if illegal.Enriched != 0 || illegal.Discarded != 1 || len(illegal.ByKey) != 0 {
		t.Fatalf("an illegal criticality must discard the item: %+v", illegal)
	}

	// A description-free item is likewise unverified, not partially usable.
	var noDesc collections.EnrichResult
	collections.ValidateEnrichment(inventory, []any{map[string]any{
		"method": "GET", "path": "/customers/{id}",
		"group": "customers", "criticality": "low",
	}}, &noDesc)
	if noDesc.Enriched != 0 || noDesc.Discarded != 1 {
		t.Fatalf("an item with no description must be discarded: %+v", noDesc)
	}
}

// --- 4. HAR 1.2 ----------------------------------------------------------------------

const harFixture = `{"log":{"version":"1.2","creator":{"name":"Traceo Proxy","version":"1.0"},
 "entries":[
  {"request":{"method":"GET","url":"https://api.example.com/v1/users/42/orders/7?limit=25&expand=items",
    "queryString":[{"name":"limit","value":"25"},{"name":"expand","value":"items"}],
    "headers":[{"name":"Authorization","value":"Bearer super-secret"},
               {"name":"Accept","value":"application/json"}]},
   "response":{"status":200,"content":{"mimeType":"application/json",
     "text":"{\"id\":7,\"total\":12.5,\"items\":[{\"sku\":\"A\"}]}"}}},
  {"request":{"method":"GET","url":"https://api.example.com/v1/users/99/orders/8",
    "queryString":[],"headers":[]},
   "response":{"status":404,"content":{"mimeType":"application/json","text":"{\"error\":\"nope\"}"}}},
  {"request":{"method":"POST","url":"https://api.example.com/v1/users/3f7c1e42-6f6b-4a5f-9a1d-2b8e5c7d9f01/tokens",
    "headers":[],"postData":{"mimeType":"application/json","text":"{\"scope\":\"read\",\"ttl\":3600}"}},
   "response":{"status":201,"content":{"mimeType":"application/json","text":"{\"token\":\"x\"}"}}}
 ]}}`

func TestHARImportTemplatesConcreteIdsAsTraffic(t *testing.T) {
	headers := registerOrg(t, "HAR Org")
	projectID := createAutoProject(t, headers, "Traffic")

	res := importCollection(t, headers, projectID, "capture.har", []byte(harFixture))
	if res["format"] != "har" {
		t.Fatalf("expected format har, got %v", res["format"])
	}
	if got := num(t, res, "total"); got != 2 {
		t.Fatalf("the two /users/{id}/orders/{id2} entries must dedupe: total=%d", got)
	}

	rows := listEndpointsByKey(t, headers, projectID)
	orders, present := rows["GET /v1/users/{id}/orders/{id2}"]
	if !present {
		t.Fatalf("concrete ids were not templated; got %v", sortedRowKeys(rows))
	}
	if orders["source"] != "traffic" {
		t.Fatalf("HAR endpoints must carry source traffic, got %v", orders["source"])
	}
	if orders["observed_count"] != float64(2) {
		t.Fatalf("observed_count should count both captures, got %v", orders["observed_count"])
	}
	responses, _ := orders["response_schemas"].(M)
	for _, code := range []string{"200", "404"} {
		if _, present := responses[code]; !present {
			t.Fatalf("observed status %s missing: %v", code, responses)
		}
	}
	params := paramsByName(orders)
	if p := params["limit"]; p == nil || p["location"] != "query" || p["type"] != "integer" {
		t.Fatalf("queryString param limit not captured: %v", p)
	}
	// credential headers are captured by NAME only — never with their value
	auth, ok := params["Authorization"]
	if !ok || auth["location"] != "header" {
		t.Fatalf("Authorization header not captured: %v", auth)
	}
	if constraints, _ := auth["constraints"].(M); len(constraints) != 0 {
		t.Fatalf("a credential header value must never be recorded: %v", constraints)
	}

	// Re-importing the same capture is idempotent: nothing is added or removed and
	// no endpoint's signature moves. (`updated` counts the rows the import
	// re-wrote, which is every row it declares; `diff.changed` is the subset that
	// actually differs, and that is what "no-op" means.)
	again := importCollection(t, headers, projectID, "capture.har", []byte(harFixture))
	if num(t, again, "added") != 0 || num(t, again, "removed") != 0 {
		t.Fatalf("HAR re-import should add or remove nothing, got %v", again)
	}
	againDiff, _ := again["diff"].(M)
	if changed, _ := againDiff["changed"].([]any); len(changed) != 0 {
		t.Fatalf("HAR re-import changed endpoints: %v", changed)
	}
	if listEndpointsByKey(t, headers, projectID)["GET /v1/users/{id}/orders/{id2}"]["observed_count"] != float64(2) {
		t.Fatal("observed_count must not double on re-import")
	}

	tokens, present := rows["POST /v1/users/{id}/tokens"]
	if !present {
		t.Fatalf("UUID segment was not templated; got %v", sortedRowKeys(rows))
	}
	schema, _ := tokens["request_schema"].(M)
	props, _ := schema["properties"].(M)
	scope, _ := props["scope"].(M)
	ttl, _ := props["ttl"].(M)
	if scope["type"] != "string" || ttl["type"] != "integer" {
		t.Fatalf("postData schema not inferred from the example: %v", props)
	}
}

// --- 5. Insomnia v4 -------------------------------------------------------------------

const insomniaFixture = `{"_type":"export","__export_format":4,
 "__export_source":"insomnia.desktop.app:v8.0.0",
 "resources":[
  {"_id":"wrk_1","_type":"workspace","name":"Billing"},
  {"_id":"env_1","_type":"environment","parentId":"wrk_1",
   "data":{"baseUrl":"https://api.example.com"}},
  {"_id":"fld_1","_type":"request_group","name":"Users"},
  {"_id":"req_1","_type":"request","name":"Get user","method":"GET",
   "url":"{{ _.baseUrl }}/v2/users/:userId",
   "parameters":[{"name":"include","value":"profile"},
                 {"name":"debug","value":"true","disabled":true}],
   "headers":[{"name":"Accept","value":"application/json"}],
   "pathParameters":[{"name":"userId","value":"1234"}]},
  {"_id":"req_2","_type":"request","name":"Create user","method":"POST",
   "url":"https://api.example.com/v2/users",
   "headers":[{"name":"Content-Type","value":"application/json"}],
   "body":{"mimeType":"application/json","text":"{\"name\":\"Sara\",\"age\":30,\"tags\":[\"a\"]}"}}
 ]}`

func TestInsomniaImportReusesThePostmanSource(t *testing.T) {
	headers := registerOrg(t, "Insomnia Org")
	projectID := createAutoProject(t, headers, "Insomnia")

	res := importCollection(t, headers, projectID, "export.json", []byte(insomniaFixture))
	if res["format"] != "insomnia4" {
		t.Fatalf("expected format insomnia4, got %v", res["format"])
	}
	if got := num(t, res, "total"); got != 2 {
		t.Fatalf("expected 2 endpoints, got %d", got)
	}

	rows := listEndpointsByKey(t, headers, projectID)
	user, present := rows["GET /v2/users/{userId}"]
	if !present {
		t.Fatalf("':userId' was not templated / baseUrl not stripped: %v", sortedRowKeys(rows))
	}
	// the Endpoint.source enum is NOT extended — Insomnia reuses "postman"
	if user["source"] != "postman" {
		t.Fatalf("expected source postman, got %v", user["source"])
	}
	params := paramsByName(user)
	if p := params["include"]; p == nil || p["location"] != "query" {
		t.Fatalf("query parameter include missing: %v", p)
	}
	// `disabled` hides a VALUE, never the API surface: Insomnia and Postman both
	// export optional parameters disabled, so dropping them would silently lose
	// part of the documented API. A disabled parameter is simply never required.
	debug, present := params["debug"]
	if !present || debug["location"] != "query" {
		t.Fatalf("disabled query parameter debug must still be imported: %v", debug)
	}
	if debug["required"] == true {
		t.Fatalf("a disabled parameter must never be required: %v", debug)
	}
	if p := params["userId"]; p == nil || p["location"] != "path" {
		t.Fatalf("path parameter userId missing: %v", p)
	}

	create := rows["POST /v2/users"]
	if create == nil {
		t.Fatal("POST /v2/users missing")
	}
	schema, _ := create["request_schema"].(M)
	props, _ := schema["properties"].(M)
	tags, _ := props["tags"].(M)
	if tags["type"] != "array" {
		t.Fatalf("array body field not inferred: %v", props)
	}
	if len(props) != 3 {
		t.Fatalf("inferred schema invented or lost fields: %v", props)
	}
}

// --- 6. Unsupported uploads name the supported formats ---------------------------------

func TestUnsupportedUploadNamesTheSupportedFormats(t *testing.T) {
	headers := registerOrg(t, "Bad Upload Org")
	projectID := createAutoProject(t, headers, "Bad Upload")

	w := uploadFile(t, "/v1/projects/"+projectID+"/api-specs", "notes.json",
		[]byte(`{"hello":"world"}`), "application/json", headers)
	if w.Code != 422 {
		t.Fatalf("expected 422, got %d %.300s", w.Code, w.Body.String())
	}
	detail, _ := jsonMap(t, w)["detail"].(M)
	if detail["code"] != "invalid_spec" {
		t.Fatalf("the existing invalid_spec code must be kept: %v", detail)
	}
	errs, _ := detail["errors"].([]any)
	joined := ""
	for _, e := range errs {
		joined += str(e) + "\n"
	}
	for _, want := range []string{"OpenAPI", "Swagger", "Postman", "HAR", "Insomnia"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("the error list must name %q: %q", want, joined)
		}
	}
}

// --- 7. Fidelity precedence spec > traffic > dom > postman ------------------------------

func TestSpecImportOutranksCollectionsWithoutDeletingThem(t *testing.T) {
	headers := registerOrg(t, "Fidelity Org")
	projectID := createProject(t, headers, "Fidelity") // manual: enrichment off

	importCollection(t, headers, projectID, "export.json", []byte(insomniaFixture))

	spec, _ := json.Marshal(M{
		"openapi": "3.0.3",
		"info":    M{"title": "Users API", "version": "1.0.0"},
		"paths": M{
			"/v2/users": M{"post": M{"operationId": "createUser",
				"summary":   "Authoritative spec summary",
				"responses": M{"201": M{"description": "Created"}}}},
			"/v2/orders": M{"get": M{"operationId": "listOrders",
				"summary":   "List orders",
				"responses": M{"200": M{"description": "OK"}}}},
		},
	})
	res := importCollection(t, headers, projectID, "spec.json", spec)
	if res["format"] != "openapi3" {
		t.Fatalf("OpenAPI detection regressed: %v", res["format"])
	}
	if got := num(t, res, "removed"); got != 0 {
		t.Fatalf("a spec import must not delete collection endpoints, removed=%d", got)
	}

	rows := listEndpointsByKey(t, headers, projectID)
	if len(rows) != 3 {
		t.Fatalf("expected the 2 collection endpoints + 1 new spec endpoint, got %v",
			sortedRowKeys(rows))
	}
	if _, present := rows["GET /v2/users/{userId}"]; !present {
		t.Fatal("the collection-only endpoint was deleted by the spec import")
	}
	users := rows["POST /v2/users"]
	if users["source"] != "spec" {
		t.Fatalf("spec must win over postman for the same endpoint: %v", users["source"])
	}
	if users["summary"] != "Authoritative spec summary" {
		t.Fatalf("spec data did not overwrite the collection data: %v", users["summary"])
	}
	if users["operation_id"] != "createUser" {
		t.Fatalf("spec operation_id missing: %v", users["operation_id"])
	}

	// ... and a LATER collection import never downgrades the spec-sourced row
	again := importCollection(t, headers, projectID, "export.json", []byte(insomniaFixture))
	if got := num(t, again, "removed"); got != 0 {
		t.Fatalf("a collection import must not delete spec endpoints, removed=%d", got)
	}
	rows = listEndpointsByKey(t, headers, projectID)
	if len(rows) != 3 {
		t.Fatalf("inventory changed size on re-import: %v", sortedRowKeys(rows))
	}
	users = rows["POST /v2/users"]
	if users["source"] != "spec" || users["summary"] != "Authoritative spec summary" {
		t.Fatalf("lower fidelity overwrote higher fidelity: %v", users)
	}
	if _, present := rows["GET /v2/orders"]; !present {
		t.Fatal("the spec-only endpoint was deleted by the collection import")
	}
}

// --- 8. OpenAPI behaviour is unchanged ---------------------------------------------------

func TestOpenAPIImportBehaviourUnchanged(t *testing.T) {
	headers := registerOrg(t, "OpenAPI Regression Org")
	projectID := createProject(t, headers, "OpenAPI")

	res := importSpec(t, headers, projectID)
	if res["format"] != "openapi3" {
		t.Fatalf("expected format openapi3, got %v", res["format"])
	}
	if got := num(t, res, "endpoints_count"); got != 2 {
		t.Fatalf("expected 2 endpoints, got %d", got)
	}
	if got := num(t, res, "enriched"); got != 0 {
		t.Fatalf("OpenAPI imports are never enriched, got %d", got)
	}
	if _, present := res["spec_id"]; !present {
		t.Fatalf("spec_id disappeared from the response: %v", res)
	}
	rows := listEndpointsByKey(t, headers, projectID)
	if len(rows) != 2 {
		t.Fatalf("expected 2 endpoints, got %v", sortedRowKeys(rows))
	}
	for key, row := range rows {
		if row["source"] != "spec" {
			t.Fatalf("%s: OpenAPI endpoints must stay source spec: %v", key, row["source"])
		}
		if row["ai_description"] != nil || row["ai_group"] != nil || row["ai_criticality"] != nil {
			t.Fatalf("%s: ai_* must be null for spec imports: %v", key, row)
		}
	}
}

// --- 9. The mock stays deterministic, offline, and byte-identical elsewhere ---------------

func TestMockEnrichmentIsDeterministicAndAdditive(t *testing.T) {
	provider := llm.Get()
	prompt := "INVENTORY:\n" + `{"endpoints":[{"method":"GET","path":"/calendars/{calendarId}"},` +
		`{"method":"DELETE","path":"/calendars/{calendarId}"}]}`

	first, err := provider.CompleteJSON("enrich_endpoints", prompt, nil)
	if err != nil {
		t.Fatalf("mock enrichment failed: %v", err)
	}
	second, err := provider.CompleteJSON("enrich_endpoints", prompt, nil)
	if err != nil {
		t.Fatalf("mock enrichment failed: %v", err)
	}
	a, _ := json.Marshal(first.Data)
	b, _ := json.Marshal(second.Data)
	if string(a) != string(b) {
		t.Fatalf("mock enrichment is not deterministic:\n%s\n%s", a, b)
	}
	items, _ := first.Data["endpoints"].([]any)
	if len(items) != 2 {
		t.Fatalf("expected one item per endpoint, got %s", a)
	}
	for _, entry := range items {
		item, _ := entry.(map[string]any)
		if item["path"] != "/calendars/{calendarId}" {
			t.Fatalf("the mock must copy the path verbatim: %v", item)
		}
		switch item["criticality"] {
		case "high", "medium", "low":
		default:
			t.Fatalf("illegal criticality: %v", item)
		}
	}

	// pre-existing mock behaviours are untouched
	extract, err := provider.CompleteJSON("extract_requirement",
		"SEGMENT:\nFR-001 The system must respond within 2 seconds.\n- Criterion one", nil)
	if err != nil {
		t.Fatalf("extract mock failed: %v", err)
	}
	if extract.Data["external_id"] != "FR-001" || extract.Data["type"] != "non_functional" ||
		extract.Data["priority"] != "high" {
		t.Fatalf("existing extract_requirement behaviour changed: %v", extract.Data)
	}
	unknown, err := provider.CompleteJSON("something_else", "irrelevant", nil)
	if err != nil {
		t.Fatalf("unknown prompt id failed: %v", err)
	}
	if len(unknown.Data) != 0 {
		t.Fatalf("unknown prompt ids must still return an empty object: %v", unknown.Data)
	}
}

// --- 10. Detection is pure and total ------------------------------------------------------

func TestDetectionIsDeterministic(t *testing.T) {
	cases := []struct {
		doc  string
		want string
	}{
		{`{"info":{"schema":"https://schema.getpostman.com/json/collection/v2.1.0/collection.json"},"item":[]}`, "postman2"},
		{`{"info":{"schema":"https://schema.getpostman.com/json/collection/v2.0.0/collection.json"},"item":[]}`, "postman2"},
		{`{"log":{"version":"1.2","entries":[]}}`, "har"},
		{`{"_type":"export","resources":[]}`, "insomnia4"},
		{`{"openapi":"3.0.3","paths":{}}`, ""},
		{`{"swagger":"2.0","paths":{}}`, ""},
		{`{"info":{"schema":"https://example.com/other.json"}}`, ""},
		{`[]`, ""},
	}
	for _, tc := range cases {
		var doc any
		if err := json.Unmarshal([]byte(tc.doc), &doc); err != nil {
			t.Fatalf("bad fixture %q: %v", tc.doc, err)
		}
		if got := collections.Detect(doc); got != tc.want {
			t.Fatalf("Detect(%s) = %q, want %q", tc.doc, got, tc.want)
		}
	}
	if collections.SourceFor("har") != "traffic" {
		t.Fatal("HAR must map onto the traffic source")
	}
	if collections.SourceFor("postman2") != "postman" ||
		collections.SourceFor("insomnia4") != "postman" {
		t.Fatal("collections must reuse the postman source (no enum change)")
	}
}

// --- 11. The new columns are nullable and migrate in place ---------------------------------

func TestEnrichmentColumnsAreNullable(t *testing.T) {
	headers, orgID, _ := seedOrgUser(t, "Nullable Columns Org", "admin")
	_ = headers
	projectID := seedProject(t, orgID, "Nullable")
	row := models.Endpoint{OrganisationID: orgID, ProjectID: projectID,
		Method: "GET", Path: "/plain", Source: "spec"}
	if err := db.DB.Create(&row).Error; err != nil {
		t.Fatalf("insert without ai_* columns failed: %v", err)
	}
	var back models.Endpoint
	if err := db.DB.First(&back, "id = ?", row.ID).Error; err != nil {
		t.Fatalf("read back failed: %v", err)
	}
	if back.AIDescription != nil || back.AIGroup != nil || back.AICriticality != nil {
		t.Fatalf("ai_* columns should default to NULL: %+v", back)
	}
}

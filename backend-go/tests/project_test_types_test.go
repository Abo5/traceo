package tests_test

import (
	"testing"

	"traceo/internal/db"
	"traceo/internal/models"
	"traceo/internal/testtypes"
)

// A project declares which of the five kinds of testing it is for. These mirror
// backend/tests/test_project_test_types.py one for one — the two backends must
// answer identically, including which requests they refuse and with what code.

func allFive() []string { return testtypes.DefaultForProject() }

func sameStrings(got []string, want []string) bool {
	if len(got) != len(want) {
		return false
	}
	for i := range got {
		if got[i] != want[i] {
			return false
		}
	}
	return true
}

func typesOf(t *testing.T, payload map[string]any) []string {
	t.Helper()
	raw, ok := payload["test_types"].([]any)
	if !ok {
		t.Fatalf("payload has no test_types: %v", payload)
	}
	out := make([]string, 0, len(raw))
	for _, v := range raw {
		s, _ := v.(string)
		out = append(out, s)
	}
	return out
}

func createProjectWithTypes(t *testing.T, headers map[string]string,
	types []string) map[string]any {
	t.Helper()
	body := M{"name": "TT"}
	if types != nil {
		body["test_types"] = types
	}
	w := do(t, "POST", "/v1/projects", body, headers)
	if w.Code != 201 && w.Code != 200 {
		t.Fatalf("create project: %d %s", w.Code, w.Body.String())
	}
	return jsonMap(t, w)
}

func TestProjectWithoutAChoiceIsForEveryTestType(t *testing.T) {
	headers := registerOrg(t, "TT Org")
	got := typesOf(t, createProjectWithTypes(t, headers, nil))
	if !sameStrings(got, allFive()) {
		t.Fatalf("test_types = %v, want %v", got, allFive())
	}
}

func TestProjectTestTypesAreStoredCanonically(t *testing.T) {
	headers := registerOrg(t, "TT Org")
	// listed out of order and with a duplicate — neither may change what runs
	got := typesOf(t, createProjectWithTypes(t,
		headers, []string{"security", "functional", "security"}))
	if !sameStrings(got, []string{"functional", "security"}) {
		t.Fatalf("test_types = %v", got)
	}
}

func TestProjectTestTypesSurviveAReread(t *testing.T) {
	headers := registerOrg(t, "TT Org")
	pid, _ := createProjectWithTypes(t, headers, []string{"api"})["id"].(string)

	w := do(t, "GET", "/v1/projects/"+pid, nil, headers)
	if got := typesOf(t, jsonMap(t, w)); !sameStrings(got, []string{"api"}) {
		t.Fatalf("after reread: %v", got)
	}

	list := itemsOf(jsonAny(t, do(t, "GET", "/v1/projects", nil, headers)))
	for _, item := range list {
		row, _ := item.(map[string]any)
		if row["id"] == pid {
			if got := typesOf(t, row); !sameStrings(got, []string{"api"}) {
				t.Fatalf("in list: %v", got)
			}
			return
		}
	}
	t.Fatal("the project is missing from the list")
}

func TestProjectRefusesAnUnknownTestTypeAndNamesTheLegalList(t *testing.T) {
	headers := registerOrg(t, "TT Org")
	w := do(t, "POST", "/v1/projects",
		M{"name": "TT", "test_types": []string{"functional", "perfomance"}}, headers)
	if w.Code != 422 {
		t.Fatalf("status = %d, want 422: %s", w.Code, w.Body.String())
	}
	detail := jsonMap(t, w)["detail"].(map[string]any)
	if detail["code"] != "invalid_test_type" {
		t.Fatalf("code = %v", detail["code"])
	}
	errs, _ := detail["errors"].([]any)
	if len(errs) != len(allFive()) {
		t.Fatalf("the caller must be told what IS allowed: %v", detail)
	}
}

func TestProjectRefusesAnEmptyTestTypeChoice(t *testing.T) {
	headers := registerOrg(t, "TT Org")
	w := do(t, "POST", "/v1/projects", M{"name": "TT", "test_types": []string{}}, headers)
	if w.Code != 422 {
		t.Fatalf("status = %d, want 422: %s", w.Code, w.Body.String())
	}
}

func TestProjectTestTypesCanBeChangedAfterwards(t *testing.T) {
	headers := registerOrg(t, "TT Org")
	pid, _ := createProjectWithTypes(t, headers, allFive())["id"].(string)

	w := do(t, "PATCH", "/v1/projects/"+pid,
		M{"test_types": []string{"ui", "performance"}}, headers)
	if w.Code != 200 {
		t.Fatalf("patch: %d %s", w.Code, w.Body.String())
	}
	if got := typesOf(t, jsonMap(t, w)); !sameStrings(got, []string{"ui", "performance"}) {
		t.Fatalf("after patch: %v", got)
	}
}

func TestPatchingAnUnknownTypeLeavesTheStoredChoiceAlone(t *testing.T) {
	headers := registerOrg(t, "TT Org")
	pid, _ := createProjectWithTypes(t, headers, []string{"api"})["id"].(string)

	if w := do(t, "PATCH", "/v1/projects/"+pid,
		M{"test_types": []string{"api", "nope"}}, headers); w.Code != 422 {
		t.Fatalf("status = %d, want 422", w.Code)
	}
	w := do(t, "GET", "/v1/projects/"+pid, nil, headers)
	if got := typesOf(t, jsonMap(t, w)); !sameStrings(got, []string{"api"}) {
		t.Fatalf("a refused patch must not change the stored choice: %v", got)
	}
}

func TestAProjectRowThatPredatesTheFieldReadsAsAllFive(t *testing.T) {
	headers := registerOrg(t, "TT Org")
	pid, _ := createProjectWithTypes(t, headers, []string{"api"})["id"].(string)

	// exactly what the migration leaves behind on an existing row
	db.DB.Model(&models.Project{}).Where("id = ?", pid).
		Update("test_types", models.StringList{})

	w := do(t, "GET", "/v1/projects/"+pid, nil, headers)
	if got := typesOf(t, jsonMap(t, w)); !sameStrings(got, allFive()) {
		t.Fatalf("an empty stored value must read as all five, got %v", got)
	}
}

func TestWebTargetDefaultsToWhatTheProjectDeclared(t *testing.T) {
	withSidecar(t, recordedPayload(t))
	headers := registerOrg(t, "TT Org")
	pid, _ := createProjectWithTypes(t, headers, []string{"ui", "security"})["id"].(string)

	w := do(t, "POST", "/v1/projects/"+pid+"/web-targets",
		M{"url": webTargetURL}, headers)
	if w.Code != 202 {
		t.Fatalf("status = %d: %s", w.Code, w.Body.String())
	}
	if got := typesOf(t, jsonMap(t, w)); !sameStrings(got, []string{"ui", "security"}) {
		t.Fatalf("an omitted list must run the project's declaration, got %v", got)
	}
}

func TestWebTargetCannotAskForATypeTheProjectExcluded(t *testing.T) {
	withSidecar(t, recordedPayload(t))
	headers := registerOrg(t, "TT Org")
	pid, _ := createProjectWithTypes(t, headers, []string{"ui"})["id"].(string)

	w := do(t, "POST", "/v1/projects/"+pid+"/web-targets",
		M{"url": webTargetURL, "test_types": []string{"ui", "security"}}, headers)
	if w.Code != 422 {
		t.Fatalf("status = %d, want 422: %s", w.Code, w.Body.String())
	}
	detail := jsonMap(t, w)["detail"].(map[string]any)
	if detail["code"] != "test_type_not_in_project" {
		t.Fatalf("code = %v", detail["code"])
	}
	errs, _ := detail["errors"].([]any)
	if len(errs) != 1 || errs[0] != "ui" {
		t.Fatalf("errors must name what the project IS for: %v", detail["errors"])
	}
}

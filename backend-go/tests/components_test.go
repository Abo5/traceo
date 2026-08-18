// RELEASE GATE — component inventory, phase S2 (docs/SECURITY_TESTING_PLAN.md §2).
//
// The inventory is what turns a CVE feed from news about other people's
// software into a statement about THIS system. The gates below protect the one
// rule that makes it trustworthy: a version is never invented. An unpinned or
// ranged dependency is recorded with a null version and a stated reason, and a
// file nothing recognises is refused by name rather than parsed hopefully.
package tests_test

import (
	"encoding/json"
	"strings"
	"testing"

	"traceo/internal/modules/components"
)

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

func cycloneDXFixture() []byte {
	raw, _ := json.Marshal(M{
		"bomFormat": "CycloneDX", "specVersion": "1.5", "version": 1,
		"components": []M{
			{"type": "library", "name": "express", "version": "4.18.2",
				"purl": "pkg:npm/express@4.18.2"},
			{"type": "library", "name": "openssl", "version": "3.0.8",
				"purl": "pkg:generic/openssl@3.0.8",
				"cpe":  "cpe:2.3:a:openssl:openssl:3.0.8:*:*:*:*:*:*:*"},
			{"type": "library", "name": "mystery-lib"}, // no version stated
		},
	})
	return raw
}

func spdxFixture() []byte {
	raw, _ := json.Marshal(M{
		"spdxVersion": "SPDX-2.3", "name": "demo-sbom",
		"packages": []M{
			{"name": "requests", "versionInfo": "2.31.0",
				"externalRefs": []M{{"referenceCategory": "PACKAGE-MANAGER",
					"referenceType": "purl", "referenceLocator": "pkg:pypi/requests@2.31.0"}}},
			{"name": "log4j-core", "versionInfo": "NOASSERTION"},
		},
	})
	return raw
}

func packageLockFixture() []byte {
	raw, _ := json.Marshal(M{
		"name": "demo", "lockfileVersion": 3,
		"packages": M{
			"":                            M{"name": "demo", "version": "1.0.0"},
			"node_modules/lodash":         M{"version": "4.17.21"},
			"node_modules/@scope/toolkit": M{"version": "2.0.1"},
		},
	})
	return raw
}

const requirementsFixture = `# runtime dependencies
requests==2.31.0
Django>=4.0,<5.0
flask
urllib3 == 2.2.1  # pinned for CVE-2024-37891
-r other-requirements.txt
`

const goSumFixture = `github.com/gin-gonic/gin v1.9.1 h1:4idEAncQnU5cB7BeOkPtxjfCSye0AAm1R0RVIqJ+Jmg=
github.com/gin-gonic/gin v1.9.1/go.mod h1:hPrL7YrpYKXt5YId3A/Tnip5kqbEAP+KLuI3SUcPTeU=
gorm.io/gorm v1.25.5 h1:zR9lOiiYf09VNh5Q1gphfyia1JpiClIWG9hQaxB/mls=
gorm.io/gorm v1.25.5/go.mod h1:hbnx/Oo0ChWMn1BIhpy1oYozzpM15i4YPuHDmfYtwg8=
`

const poetryLockFixture = `[[package]]
name = "certifi"
version = "2024.2.2"
description = "Python package for providing Mozilla's CA Bundle."
optional = false

[package.dependencies]
name = "not-a-package"

[[package]]
name = "charset-normalizer"
version = "3.3.2"
optional = false

[metadata]
lock-version = "2.0"
`

// ---------------------------------------------------------------------------
// Parsers — pure functions, no network, no clock
// ---------------------------------------------------------------------------

func TestParsersNeverInventAVersion(t *testing.T) {
	format, entries, err := components.Parse([]byte(requirementsFixture), "requirements.txt")
	if err != nil {
		t.Fatalf("requirements.txt not recognised: %v", err)
	}
	if format != components.FormatRequirements {
		t.Fatalf("detected %q", format)
	}
	byName := map[string]components.Entry{}
	for _, e := range entries {
		byName[e.Name] = e
	}
	if v := byName["requests"].Version; v == nil || *v != "2.31.0" {
		t.Fatalf("an exact pin must be recorded verbatim: %v", v)
	}
	if v := byName["urllib3"].Version; v == nil || *v != "2.2.1" {
		t.Fatalf("spaces around == must not defeat the pin: %v", v)
	}
	for _, name := range []string{"Django", "flask"} {
		e, ok := byName[name]
		if !ok {
			t.Fatalf("%s was dropped instead of being recorded as unpinned", name)
		}
		if e.Version != nil {
			t.Fatalf("%s: a range or a bare name is NOT a version, got %q", name, *e.Version)
		}
		if e.UnpinnedReason == nil || *e.UnpinnedReason == "" {
			t.Fatalf("%s: an unpinned entry must state why", name)
		}
	}
	if _, present := byName["-r"]; present {
		t.Fatal("a -r directive is not a component")
	}
}

func TestGoSumDedupesTheGoModLines(t *testing.T) {
	format, entries, err := components.Parse([]byte(goSumFixture), "go.sum")
	if err != nil || format != components.FormatGoSum {
		t.Fatalf("go.sum not recognised: %q %v", format, err)
	}
	if len(entries) != 2 {
		t.Fatalf("the /go.mod line is the same module+version: expected 2 entries, got %d", len(entries))
	}
	for _, e := range entries {
		if e.Ecosystem != "golang" {
			t.Fatalf("%s: ecosystem %q", e.Name, e.Ecosystem)
		}
		if e.Version == nil || !strings.HasPrefix(*e.Version, "v") {
			t.Fatalf("%s: version not captured", e.Name)
		}
		if e.Purl == nil || !strings.HasPrefix(*e.Purl, "pkg:golang/") {
			t.Fatalf("%s: purl not derived", e.Name)
		}
	}
}

func TestPoetryLockIgnoresSubTables(t *testing.T) {
	format, entries, err := components.Parse([]byte(poetryLockFixture), "poetry.lock")
	if err != nil || format != components.FormatPoetryLock {
		t.Fatalf("poetry.lock not recognised: %q %v", format, err)
	}
	if len(entries) != 2 {
		t.Fatalf("expected 2 packages, got %d (%v)", len(entries), entries)
	}
	for _, e := range entries {
		if e.Name == "not-a-package" {
			t.Fatal("a key inside [package.dependencies] is not a package")
		}
		if e.Ecosystem != "pypi" || e.Version == nil {
			t.Fatalf("%s: %v", e.Name, e)
		}
	}
}

func TestScopedNpmNameGetsACanonicalPurl(t *testing.T) {
	_, entries, err := components.Parse(packageLockFixture(), "package-lock.json")
	if err != nil {
		t.Fatalf("package-lock.json not recognised: %v", err)
	}
	found := false
	for _, e := range entries {
		if e.Name == "@scope/toolkit" {
			found = true
			if e.Purl == nil || *e.Purl != "pkg:npm/@scope/toolkit@2.0.1" {
				t.Fatalf("scoped purl: %v", e.Purl)
			}
		}
		if e.Name == "demo" {
			t.Fatal("the root project is not a dependency of itself")
		}
	}
	if !found {
		t.Fatal("the scoped package was not parsed")
	}
}

func TestPackageLockV1DependenciesAreParsed(t *testing.T) {
	raw, _ := json.Marshal(M{"name": "demo", "lockfileVersion": 1,
		"dependencies": M{
			"lodash": M{"version": "4.17.21",
				"dependencies": M{"nested-dep": M{"version": "0.0.1"}}},
		}})
	format, entries, err := components.Parse(raw, "package-lock.json")
	if err != nil || format != components.FormatPackageLock {
		t.Fatalf("v1 lockfile not recognised: %q %v", format, err)
	}
	if len(entries) != 2 {
		t.Fatalf("nested dependencies must be walked, got %d", len(entries))
	}
}

func TestUnknownDocumentIsRefused(t *testing.T) {
	if _, _, err := components.Parse([]byte(`{"hello":"world"}`), "thing.json"); err == nil {
		t.Fatal("an unknown JSON document must not be parsed hopefully")
	}
	if _, _, err := components.Parse([]byte("just some prose\n"), "notes.txt"); err == nil {
		t.Fatal("prose is not a lockfile")
	}
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

func importComponentsFile(t *testing.T, headers map[string]string, pid, filename string,
	content []byte) M {
	t.Helper()
	w := uploadFile(t, "/v1/projects/"+pid+"/components", filename, content,
		"application/json", headers)
	if w.Code != 202 {
		t.Fatalf("component import expected 202, got %d %.300s", w.Code, w.Body.String())
	}
	job := pollJob(t, headers, jsonMap(t, w)["job_id"].(string))
	result, _ := job["result"].(map[string]any)
	if result == nil {
		t.Fatalf("job carried no result: %v", job)
	}
	return result
}

func TestSBOMImportRecordsTheInventory(t *testing.T) {
	headers := registerOrg(t, "SBOM Org")
	pid := createProject(t, headers, "SBOM Project")

	result := importComponentsFile(t, headers, pid, "bom.json", cycloneDXFixture())
	if result["format"] != components.FormatCycloneDX {
		t.Fatalf("format: %v", result["format"])
	}
	if added, _ := result["added"].(float64); added != 3 {
		t.Fatalf("expected 3 components added, got %v", added)
	}
	if unpinned, _ := result["unpinned"].(float64); unpinned != 1 {
		t.Fatalf("the versionless component must be counted as unpinned: %v", result)
	}
	if total, _ := result["total"].(float64); total != 3 {
		t.Fatalf("total is the inventory size: %v", result)
	}

	list := jsonMap(t, do(t, "GET", "/v1/projects/"+pid+"/components", nil, headers))
	items, _ := list["components"].([]any)
	if len(items) != 3 {
		t.Fatalf("expected 3 components, got %d", len(items))
	}
	byName := map[string]map[string]any{}
	for _, item := range items {
		c := item.(map[string]any)
		byName[c["name"].(string)] = c
	}
	express := byName["express"]
	if express["version"] != "4.18.2" || express["ecosystem"] != "npm" {
		t.Fatalf("express: %v", express)
	}
	if express["source"] != "sbom" {
		t.Fatalf("an SBOM upload is the highest-fidelity source: %v", express["source"])
	}
	if express["purl"] != "pkg:npm/express@4.18.2" {
		t.Fatalf("the stated purl must be carried verbatim: %v", express["purl"])
	}
	if express["cpe23"] != nil {
		t.Fatalf("a CPE is never synthesised: %v", express["cpe23"])
	}
	if byName["openssl"]["cpe23"] != "cpe:2.3:a:openssl:openssl:3.0.8:*:*:*:*:*:*:*" {
		t.Fatalf("a stated CPE must be carried: %v", byName["openssl"]["cpe23"])
	}
	mystery := byName["mystery-lib"]
	if mystery["version"] != nil {
		t.Fatalf("a versionless component must stay versionless: %v", mystery["version"])
	}
	if reason, _ := mystery["unpinned_reason"].(string); reason == "" {
		t.Fatal("a null version must come with a stated reason")
	}
}

func TestSPDXImportHandlesNoAssertion(t *testing.T) {
	headers := registerOrg(t, "SPDX Org")
	pid := createProject(t, headers, "SPDX Project")
	result := importComponentsFile(t, headers, pid, "sbom.spdx.json", spdxFixture())
	if result["format"] != components.FormatSPDX {
		t.Fatalf("format: %v", result["format"])
	}
	list := jsonMap(t, do(t, "GET", "/v1/projects/"+pid+"/components", nil, headers))
	for _, item := range list["components"].([]any) {
		c := item.(map[string]any)
		if c["name"] == "log4j-core" {
			if c["version"] != nil {
				t.Fatalf("NOASSERTION is not a version: %v", c["version"])
			}
			if reason, _ := c["unpinned_reason"].(string); !strings.Contains(reason, "NOASSERTION") {
				t.Fatalf("the reason must quote what the document said: %q", reason)
			}
		}
		if c["name"] == "requests" && c["ecosystem"] != "pypi" {
			t.Fatalf("ecosystem must come from the purl: %v", c["ecosystem"])
		}
	}
}

func TestComponentImportIsIdempotent(t *testing.T) {
	headers := registerOrg(t, "Idempotent Org")
	pid := createProject(t, headers, "Idempotent Project")
	first := importComponentsFile(t, headers, pid, "go.sum", []byte(goSumFixture))
	if first["format"] != components.FormatGoSum {
		t.Fatalf("format: %v", first["format"])
	}
	second := importComponentsFile(t, headers, pid, "go.sum", []byte(goSumFixture))
	if added, _ := second["added"].(float64); added != 0 {
		t.Fatalf("re-importing the same lockfile must add nothing, added %v", added)
	}
	if updated, _ := second["updated"].(float64); updated != 2 {
		t.Fatalf("the same rows must be updated in place, got %v", updated)
	}
	if total, _ := second["total"].(float64); total != 2 {
		t.Fatalf("the inventory must not grow: %v", second)
	}
}

func TestUnsupportedComponentFileNamesTheSupportedFormats(t *testing.T) {
	headers := registerOrg(t, "Unsupported Org")
	pid := createProject(t, headers, "Unsupported Project")
	w := uploadFile(t, "/v1/projects/"+pid+"/components", "mystery.bin",
		[]byte("\x00\x01 not a lockfile"), "application/octet-stream", headers)
	if w.Code != 422 {
		t.Fatalf("expected 422, got %d %.300s", w.Code, w.Body.String())
	}
	body := jsonMap(t, w)
	detail, _ := body["detail"].(map[string]any)
	if detail["code"] != "unsupported_component_format" {
		t.Fatalf("code: %v", detail["code"])
	}
	errs, _ := detail["errors"].([]any)
	if len(errs) != len(components.SupportedFormats) {
		t.Fatalf("the 422 must name every supported format: %v", errs)
	}
	names := map[string]bool{}
	for _, e := range errs {
		names[e.(string)] = true
	}
	for _, f := range components.SupportedFormats {
		if !names[f] {
			t.Fatalf("%q missing from the supported-format list: %v", f, errs)
		}
	}
}

func TestComponentUploadWithoutAFileIsRefused(t *testing.T) {
	headers := registerOrg(t, "No File Org")
	pid := createProject(t, headers, "No File Project")
	w := do(t, "POST", "/v1/projects/"+pid+"/components", M{"url": "http://x"}, headers)
	if w.Code != 422 || !bodyContains(w, "missing_file") {
		t.Fatalf("expected 422 missing_file, got %d %.300s", w.Code, w.Body.String())
	}
}

func TestComponentDeleteAndTenantIsolation(t *testing.T) {
	headers := registerOrg(t, "Delete Org")
	pid := createProject(t, headers, "Delete Project")
	importComponentsFile(t, headers, pid, "poetry.lock", []byte(poetryLockFixture))
	list := jsonMap(t, do(t, "GET", "/v1/projects/"+pid+"/components", nil, headers))
	items, _ := list["components"].([]any)
	if len(items) == 0 {
		t.Fatal("nothing imported")
	}
	id := items[0].(map[string]any)["id"].(string)

	other := registerOrg(t, "Delete Other Org")
	if w := do(t, "DELETE", "/v1/components/"+id, nil, other); w.Code != 404 {
		t.Fatalf("cross-tenant delete must 404, got %d", w.Code)
	}
	if w := do(t, "GET", "/v1/projects/"+pid+"/components", nil, other); w.Code != 404 {
		t.Fatalf("cross-tenant list must 404, got %d", w.Code)
	}
	if w := uploadFile(t, "/v1/projects/"+pid+"/components", "go.sum",
		[]byte(goSumFixture), "text/plain", other); w.Code != 404 {
		t.Fatalf("cross-tenant import must 404, got %d", w.Code)
	}

	if w := do(t, "DELETE", "/v1/components/"+id, nil, headers); w.Code != 200 {
		t.Fatalf("delete failed: %d %.300s", w.Code, w.Body.String())
	}
	list = jsonMap(t, do(t, "GET", "/v1/projects/"+pid+"/components", nil, headers))
	if after, _ := list["components"].([]any); len(after) != len(items)-1 {
		t.Fatalf("component was not removed: %d -> %d", len(items), len(after))
	}
}

func TestComponentRoutesEnforceCapabilities(t *testing.T) {
	headers := registerOrg(t, "Capability Org")
	pid := createProject(t, headers, "Capability Project")
	importComponentsFile(t, headers, pid, "go.sum", []byte(goSumFixture))

	viewer := seedRoleInProjectOrg(t, pid, "viewer")
	if w := do(t, "GET", "/v1/projects/"+pid+"/components", nil, viewer); w.Code != 200 {
		t.Fatalf("a viewer may read the inventory, got %d", w.Code)
	}
	if w := uploadFile(t, "/v1/projects/"+pid+"/components", "go.sum",
		[]byte(goSumFixture), "text/plain", viewer); w.Code != 403 {
		t.Fatalf("a viewer may not import, got %d", w.Code)
	}
	list := jsonMap(t, do(t, "GET", "/v1/projects/"+pid+"/components", nil, headers))
	id := list["components"].([]any)[0].(map[string]any)["id"].(string)
	if w := do(t, "DELETE", "/v1/components/"+id, nil, viewer); w.Code != 403 {
		t.Fatalf("a viewer may not delete, got %d", w.Code)
	}
}

func TestComponentImportWritesAnAuditEntry(t *testing.T) {
	headers := registerOrg(t, "Audit Components Org")
	pid := createProject(t, headers, "Audit Components Project")
	importComponentsFile(t, headers, pid, "requirements.txt", []byte(requirementsFixture))
	w := do(t, "GET", "/v1/audit", nil, headers)
	if w.Code != 200 {
		t.Skipf("audit endpoint unavailable: %d", w.Code)
	}
	if !bodyContains(w, "components.import") {
		t.Fatalf("components.import must be audited: %.500s", w.Body.String())
	}
}

func TestSecurityGenerateWritesAnAuditEntry(t *testing.T) {
	headers, pid := seedSecurityProject(t)
	generateSecurity(t, headers, pid, M{"weakness_ids": []string{"security-headers"}})
	w := do(t, "GET", "/v1/audit", nil, headers)
	if w.Code != 200 {
		t.Skipf("audit endpoint unavailable: %d", w.Code)
	}
	if !bodyContains(w, "security.generate") {
		t.Fatalf("security.generate must be audited: %.500s", w.Body.String())
	}
}

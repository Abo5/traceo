// parse.go — SBOM and lockfile parsers (SECURITY_TESTING_PLAN §2, phase S2.1).
//
// Every function here is PURE: bytes in, entries out. No network, no filesystem,
// no clock — which is what lets the whole component track run air-gapped and be
// tested offline.
//
// The one rule that governs all six parsers: A VERSION IS NEVER INVENTED. An
// unpinned or ranged dependency is recorded with a null version and a stated
// reason, because "we do not know which version runs" is a fact the CVE track
// must be told, not a blank to fill in.
package components

import (
	"encoding/json"
	"errors"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// Format ids, in the order GET/422 reports them.
const (
	FormatCycloneDX    = "cyclonedx"
	FormatSPDX         = "spdx"
	FormatPackageLock  = "package-lock.json"
	FormatRequirements = "requirements.txt"
	FormatGoSum        = "go.sum"
	FormatPoetryLock   = "poetry.lock"
)

// SupportedFormats is the closed list echoed in the 422 body so a caller whose
// file matched nothing learns what would have matched.
var SupportedFormats = []string{
	FormatCycloneDX, FormatSPDX, FormatPackageLock,
	FormatRequirements, FormatGoSum, FormatPoetryLock,
}

// ErrUnsupportedFormat is returned when no parser recognises the document.
var ErrUnsupportedFormat = errors.New("unsupported component format")

// SourceForFormat maps a format to its fidelity tier (§2).
func SourceForFormat(format string) string {
	switch format {
	case FormatCycloneDX, FormatSPDX:
		return "sbom"
	case FormatPackageLock, FormatRequirements, FormatGoSum, FormatPoetryLock:
		return "lockfile"
	}
	return "manual"
}

// Entry is one parsed component. Version is nil exactly when the document does
// not state an exact version; UnpinnedReason then says why.
type Entry struct {
	Name           string
	Version        *string
	Ecosystem      string
	Purl           *string
	CPE23          *string
	UnpinnedReason *string
}

func sptr(s string) *string { return &s }

func truncRunes(s string, n int) string {
	r := []rune(s)
	if len(r) > n {
		return string(r[:n])
	}
	return s
}

// Parse detects the format and returns its components. The filename is a hint
// only — detection is content-based, so a renamed file still parses.
func Parse(raw []byte, filename string) (string, []Entry, error) {
	var any1 any
	if err := json.Unmarshal(raw, &any1); err == nil {
		doc, isObject := any1.(map[string]any)
		if !isObject {
			// Valid JSON, but no component format takes that shape.
			return "", nil, ErrUnsupportedFormat
		}
		switch {
		case strings.EqualFold(strings.TrimSpace(str(doc["bomFormat"])), "cyclonedx"):
			return FormatCycloneDX, dedupe(parseCycloneDX(doc)), nil
		case str(doc["spdxVersion"]) != "":
			return FormatSPDX, dedupe(parseSPDX(doc)), nil
		case isPackageLock(doc, filename):
			return FormatPackageLock, dedupe(parsePackageLock(doc)), nil
		}
		return "", nil, ErrUnsupportedFormat
	}

	text := string(raw)
	base := strings.ToLower(filepath.Base(filename))
	switch {
	case looksLikePoetryLock(text):
		return FormatPoetryLock, dedupe(parsePoetryLock(text)), nil
	case looksLikeGoSum(text):
		return FormatGoSum, dedupe(parseGoSum(text)), nil
	case looksLikeRequirements(text, strings.HasPrefix(base, "requirements")):
		return FormatRequirements, dedupe(parseRequirements(text)), nil
	}
	return "", nil, ErrUnsupportedFormat
}

// dedupe collapses identical (name, version, ecosystem) triples, keeping the
// first occurrence — the same package is listed twice in most lockfiles.
func dedupe(entries []Entry) []Entry {
	seen := map[string]bool{}
	out := make([]Entry, 0, len(entries))
	for _, e := range entries {
		if strings.TrimSpace(e.Name) == "" {
			continue
		}
		v := ""
		if e.Version != nil {
			v = *e.Version
		}
		key := e.Ecosystem + "|" + e.Name + "|" + v
		if seen[key] {
			continue
		}
		seen[key] = true
		// A reason belongs to a NULL version only, and it is a sentence, not an
		// essay: the column is a stated fact, not a log line.
		if e.Version != nil {
			e.UnpinnedReason = nil
		} else if e.UnpinnedReason != nil {
			clipped := truncRunes(*e.UnpinnedReason, 200)
			e.UnpinnedReason = &clipped
		}
		out = append(out, e)
	}
	return out
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

func str(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}

func asMap(v any) map[string]any {
	m, _ := v.(map[string]any)
	return m
}

func asList(v any) []any {
	l, _ := v.([]any)
	return l
}

func sortedKeys(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// ---------------------------------------------------------------------------
// purl / cpe derivation
// ---------------------------------------------------------------------------

var pypiNormalize = regexp.MustCompile(`[-_.]+`)

// DerivePurl builds a package URL from the ecosystem, name and version. It is
// deterministic and adds nothing the inputs do not already state: an unpinned
// component gets a versionless purl rather than a fabricated one.
func DerivePurl(ecosystem, name string, version *string) *string {
	name = strings.TrimSpace(name)
	if name == "" {
		return nil
	}
	eco := ecosystem
	if eco == "" {
		eco = "generic"
	}
	// A scoped npm name keeps its "@scope/" prefix verbatim — readable, and
	// reversible — rather than percent-encoding the "@".
	ident := name
	if eco == "pypi" {
		ident = pypiNormalize.ReplaceAllString(strings.ToLower(name), "-")
	}
	out := "pkg:" + eco + "/" + ident
	if version != nil && *version != "" {
		out += "@" + *version
	}
	return &out
}

// ecosystemFromPurl reads the purl type, e.g. "pkg:npm/left-pad@1.3.0" -> "npm".
func ecosystemFromPurl(purl string) string {
	if !strings.HasPrefix(purl, "pkg:") {
		return ""
	}
	rest := purl[4:]
	if i := strings.Index(rest, "/"); i > 0 {
		return strings.ToLower(rest[:i])
	}
	return ""
}

// ---------------------------------------------------------------------------
// CycloneDX JSON
// ---------------------------------------------------------------------------

func parseCycloneDX(doc map[string]any) []Entry {
	var out []Entry
	var walk func(items []any)
	walk = func(items []any) {
		for _, item := range items {
			comp := asMap(item)
			if comp == nil {
				continue
			}
			name := strings.TrimSpace(str(comp["name"]))
			// npm scopes read as "group/name"; the group of a maven or nuget
			// component reads as "group:name".
			if group := strings.TrimSpace(str(comp["group"])); group != "" && name != "" {
				if strings.HasPrefix(group, "@") {
					name = group + "/" + name
				} else {
					name = group + ":" + name
				}
			}
			if name != "" {
				out = append(out, cycloneDXEntry(comp, name))
			}
			walk(asList(comp["components"])) // CycloneDX nests assemblies
		}
	}
	walk(asList(doc["components"]))
	return out
}

func cycloneDXEntry(comp map[string]any, name string) Entry {
	purl := strings.TrimSpace(str(comp["purl"]))
	ecosystem := ecosystemFromPurl(purl)
	if ecosystem == "" {
		ecosystem = "generic"
	}
	e := Entry{Name: name, Ecosystem: ecosystem}
	if v := strings.TrimSpace(str(comp["version"])); v != "" {
		e.Version = sptr(v)
	} else {
		e.UnpinnedReason = sptr("the SBOM states no version for this component")
	}
	if purl != "" {
		e.Purl = sptr(purl)
	} else {
		e.Purl = DerivePurl(ecosystem, name, e.Version)
	}
	// A CPE is carried only when the document states one; it is never synthesised
	// from a package name, because the vendor half cannot be derived.
	if cpe := strings.TrimSpace(str(comp["cpe"])); cpe != "" {
		e.CPE23 = sptr(cpe)
	}
	return e
}

// ---------------------------------------------------------------------------
// SPDX JSON
// ---------------------------------------------------------------------------

func parseSPDX(doc map[string]any) []Entry {
	var out []Entry
	for _, item := range asList(doc["packages"]) {
		pkg := asMap(item)
		if pkg == nil {
			continue
		}
		name := strings.TrimSpace(str(pkg["name"]))
		if name == "" {
			continue
		}
		purl, cpe := "", ""
		for _, refItem := range asList(pkg["externalRefs"]) {
			ref := asMap(refItem)
			refType := strings.ToLower(str(ref["referenceType"]))
			locator := strings.TrimSpace(str(ref["referenceLocator"]))
			if locator == "" {
				continue
			}
			switch refType {
			case "purl":
				if purl == "" {
					purl = locator
				}
			case "cpe23type":
				if cpe == "" {
					cpe = locator
				}
			}
		}
		ecosystem := ecosystemFromPurl(purl)
		if ecosystem == "" {
			ecosystem = "generic"
		}
		e := Entry{Name: name, Ecosystem: ecosystem}
		version := strings.TrimSpace(str(pkg["versionInfo"]))
		switch {
		case version == "":
			e.UnpinnedReason = sptr("the SBOM states no versionInfo for this package")
		case strings.EqualFold(version, "NOASSERTION"), strings.EqualFold(version, "NONE"):
			e.UnpinnedReason = sptr("the SBOM states versionInfo '" + version + "'")
		default:
			e.Version = sptr(version)
		}
		if purl != "" {
			e.Purl = sptr(purl)
		} else {
			e.Purl = DerivePurl(ecosystem, name, e.Version)
		}
		if cpe != "" {
			e.CPE23 = sptr(cpe)
		}
		out = append(out, e)
	}
	return out
}

// ---------------------------------------------------------------------------
// package-lock.json (v1 "dependencies", v2/v3 "packages")
// ---------------------------------------------------------------------------

func isPackageLock(doc map[string]any, filename string) bool {
	if _, ok := doc["lockfileVersion"]; ok {
		return true
	}
	base := strings.ToLower(filename)
	if !strings.HasSuffix(base, "package-lock.json") && !strings.HasSuffix(base, "npm-shrinkwrap.json") {
		return false
	}
	_, hasPackages := doc["packages"]
	_, hasDeps := doc["dependencies"]
	return hasPackages || hasDeps
}

func parsePackageLock(doc map[string]any) []Entry {
	var out []Entry
	// v2/v3 carry BOTH maps for compatibility; "packages" is the authoritative one.
	if packages := asMap(doc["packages"]); len(packages) > 0 {
		for _, key := range sortedKeys(packages) { // sorted: Go maps have no order
			if key == "" {
				continue // the root project is not a dependency of itself
			}
			pkg := asMap(packages[key])
			if pkg == nil {
				continue
			}
			name := npmNameFromPath(key)
			if name == "" {
				continue
			}
			out = append(out, npmEntry(name, strings.TrimSpace(str(pkg["version"]))))
		}
		return out
	}
	var walk func(deps map[string]any)
	walk = func(deps map[string]any) {
		for _, name := range sortedKeys(deps) {
			pkg := asMap(deps[name])
			if pkg == nil {
				continue
			}
			out = append(out, npmEntry(name, strings.TrimSpace(str(pkg["version"]))))
			walk(asMap(pkg["dependencies"]))
		}
	}
	walk(asMap(doc["dependencies"]))
	return out
}

// npmNameFromPath turns "node_modules/a/node_modules/@scope/b" into "@scope/b".
func npmNameFromPath(key string) string {
	i := strings.LastIndex(key, "node_modules/")
	if i < 0 {
		return strings.TrimSpace(key)
	}
	return strings.TrimSpace(key[i+len("node_modules/"):])
}

func npmEntry(name, version string) Entry {
	e := Entry{Name: name, Ecosystem: "npm"}
	if version != "" {
		e.Version = sptr(version)
	} else {
		e.UnpinnedReason = sptr("the lockfile entry states no resolved version")
	}
	e.Purl = DerivePurl("npm", name, e.Version)
	return e
}

// ---------------------------------------------------------------------------
// requirements.txt
// ---------------------------------------------------------------------------

var (
	// name[extras]==version is the ONLY form that yields a version. Anything else
	// is a range, a marker-only line or a bare name, and is recorded unpinned.
	reqPinned = regexp.MustCompile(`^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*==\s*([^\s;#\\]+)\s*$`)
	// A requirement line at all: a name, optional extras, and an optional
	// comma-separated specifier list. Prose deliberately does not match — a file
	// that is not a requirements file must be refused, not half-parsed.
	reqAny = regexp.MustCompile(`^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*` +
		`(?:(?:===|==|>=|<=|~=|!=|<|>)\s*[^\s;#]+\s*(?:,\s*(?:===|==|>=|<=|~=|!=|<|>)\s*[^\s;#]+\s*)*)?$`)
	reqOperators = []string{"==", ">=", "<=", "~=", "!=", "<", ">"}
)

// requirementLines strips comments, blank lines, option lines (-r/-e/--flag) and
// environment markers.
func requirementLines(text string) []string {
	var out []string
	for _, raw := range strings.Split(text, "\n") {
		line := strings.TrimSpace(strings.SplitN(raw, "#", 2)[0])
		if line == "" || strings.HasPrefix(line, "-") {
			continue
		}
		line = strings.TrimSpace(strings.SplitN(line, ";", 2)[0]) // env marker
		if line != "" {
			out = append(out, line)
		}
	}
	return out
}

// looksLikeRequirements: EVERY meaningful line must be a requirement, and the
// file must carry a positive signal — a version operator, or a filename that
// says what it is. Without that second half a one-word text file would parse as
// a dependency list.
func looksLikeRequirements(text string, filenameHint bool) bool {
	lines := requirementLines(text)
	if len(lines) == 0 {
		return false
	}
	signal := filenameHint
	for _, line := range lines {
		if !reqAny.MatchString(line) {
			return false
		}
		for _, op := range reqOperators {
			if strings.Contains(line, op) {
				signal = true
				break
			}
		}
	}
	return signal
}

func parseRequirements(text string) []Entry {
	var out []Entry
	for _, line := range requirementLines(text) {
		if m := reqPinned.FindStringSubmatch(line); m != nil {
			e := Entry{Name: m[1], Ecosystem: "pypi", Version: sptr(m[2])}
			e.Purl = DerivePurl("pypi", e.Name, e.Version)
			out = append(out, e)
			continue
		}
		m := reqAny.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		// A range or a bare name. The version is UNKNOWN, and unknown is what
		// gets stored — resolving ">=2.31.0" to a number would be a guess.
		e := Entry{Name: m[1], Ecosystem: "pypi",
			UnpinnedReason: sptr("requirement line is not pinned with '==': '" + line + "'")}
		e.Purl = DerivePurl("pypi", e.Name, nil)
		out = append(out, e)
	}
	return out
}

// ---------------------------------------------------------------------------
// go.sum
// ---------------------------------------------------------------------------

var goSumLine = regexp.MustCompile(`^(\S+)\s+(v\S+?)(/go\.mod)?\s+h1:\S+=?\s*$`)

func looksLikeGoSum(text string) bool {
	for _, raw := range strings.Split(text, "\n") {
		line := strings.TrimSpace(raw)
		if line == "" {
			continue
		}
		if goSumLine.MatchString(line) {
			return true
		}
	}
	return false
}

func parseGoSum(text string) []Entry {
	var out []Entry
	for _, raw := range strings.Split(text, "\n") {
		line := strings.TrimSpace(raw)
		if line == "" {
			continue
		}
		m := goSumLine.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		// The "/go.mod" line is the same module+version as its content line;
		// dedupe() collapses the pair.
		module, version := m[1], m[2]
		e := Entry{Name: module, Ecosystem: "golang", Version: sptr(version)}
		e.Purl = DerivePurl("golang", module, e.Version)
		out = append(out, e)
	}
	return out
}

// ---------------------------------------------------------------------------
// poetry.lock
// ---------------------------------------------------------------------------

var tomlString = regexp.MustCompile(`^\s*(name|version)\s*=\s*"([^"]*)"\s*$`)

func looksLikePoetryLock(text string) bool {
	return strings.Contains(text, "[[package]]")
}

func parsePoetryLock(text string) []Entry {
	var out []Entry
	name, version := "", ""
	inPackage, inSubTable := false, false
	flush := func() {
		if !inPackage || name == "" {
			return
		}
		e := Entry{Name: name, Ecosystem: "pypi"}
		if version != "" {
			e.Version = sptr(version)
		} else {
			e.UnpinnedReason = sptr("the lock entry states no version")
		}
		e.Purl = DerivePurl("pypi", name, e.Version)
		out = append(out, e)
	}
	for _, raw := range strings.Split(text, "\n") {
		line := strings.TrimSpace(raw)
		switch {
		case line == "[[package]]":
			flush()
			name, version, inPackage, inSubTable = "", "", true, false
			continue
		case strings.HasPrefix(line, "["):
			// [package.dependencies], [metadata], … — their keys are not the
			// package's own name/version.
			inSubTable = true
			continue
		}
		if !inPackage || inSubTable {
			continue
		}
		if m := tomlString.FindStringSubmatch(line); m != nil {
			if m[1] == "name" && name == "" {
				name = m[2]
			} else if m[1] == "version" && version == "" {
				version = m[2]
			}
		}
	}
	flush()
	return out
}

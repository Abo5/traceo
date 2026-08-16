// Package testtypes names the five kinds of testing Traceo performs, once.
//
// A project declares which of them it is for, and every engine that produces
// cases answers to that declaration. The vocabulary lived inside the web-target
// module while it was the only consumer; it is shared now, and a second copy of
// this list anywhere would be a bug waiting to happen — a type the UI offers
// and the backend rejects is indistinguishable, from the user's side, from a
// broken product.
package testtypes

import (
	"sort"
	"strings"
)

// All, in the order the UI shows them.
var All = []string{"functional", "api", "ui", "performance", "security"}

// DefaultForProject: a project with nothing said about it is for every kind of
// testing. Narrowing is a decision the owner makes, not a default they inherit.
func DefaultForProject() []string {
	out := make([]string, len(All))
	copy(out, All)
	return out
}

func known(value string) bool {
	for _, t := range All {
		if t == value {
			return true
		}
	}
	return false
}

// Validate normalises the requested types, returning (types, code, message).
// An unknown type is REFUSED rather than ignored: silently dropping
// "perfomance" would run four tracks and report success for five. The result is
// de-duplicated and in canonical order, so a caller cannot change what runs —
// or the order it runs in — by reordering its list.
//
// allowEmpty distinguishes "the caller chose nothing", which is an error, from
// read paths that tolerate an empty stored value.
func Validate(requested []string, allowEmpty bool) ([]string, string, string) {
	wanted := map[string]bool{}
	var unknown []string
	for _, raw := range requested {
		value := strings.ToLower(strings.TrimSpace(raw))
		if value == "" {
			continue
		}
		if !known(value) {
			if !containsString(unknown, value) {
				unknown = append(unknown, value)
			}
			continue
		}
		wanted[value] = true
	}
	if len(unknown) > 0 {
		sort.Strings(unknown)
		return nil, "invalid_test_type",
			"Unknown test type(s): " + strings.Join(unknown, ", ") + "."
	}
	if len(wanted) == 0 && !allowEmpty {
		return nil, "invalid_test_type", "Select at least one test type."
	}
	out := make([]string, 0, len(wanted))
	for _, t := range All {
		if wanted[t] {
			out = append(out, t)
		}
	}
	return out, "", ""
}

// OfProject is the types a project is for, always as a canonical, non-empty
// list. A project stored before this field existed holds an empty list, and so
// does one whose value was cleared by hand. Both mean "nothing was said", which
// is read as all five — reading it as "test nothing" would silently disable
// every project that predates the field. Unknown values are dropped rather than
// failing: this is a read path, and refusing to display a project because of
// one bad string in its column would be worse than showing the rest.
func OfProject(stored []string) []string {
	out, _, _ := Validate(stored, true)
	if len(out) == 0 {
		return DefaultForProject()
	}
	return out
}

func containsString(list []string, value string) bool {
	for _, v := range list {
		if v == value {
			return true
		}
	}
	return false
}

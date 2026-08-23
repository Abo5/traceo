package reporting

import (
	"testing"

	"traceo/internal/models"
)

// Every case must land in exactly one bucket, and the bucket must follow from
// the columns — not from the title.
func TestClassifyIsColumnDriven(t *testing.T) {
	edge := "boundary_surprise"
	cases := []struct {
		name string
		in   models.TestCase
		want string
	}{
		{"security is edge regardless of type",
			models.TestCase{Type: "negative", Technique: "security"}, "edge"},
		{"positive security is still edge",
			models.TestCase{Type: "positive", Technique: "security"}, "edge"},
		{"insight edge_case",
			models.TestCase{Type: "negative", Technique: "edge_case"}, "edge"},
		{"an edge_category alone is enough",
			models.TestCase{Type: "positive", Technique: "ep", EdgeCategory: &edge}, "edge"},
		{"bva is boundary",
			models.TestCase{Type: "negative", Technique: "bva"}, "boundary"},
		{"boundary type is boundary",
			models.TestCase{Type: "boundary", Technique: "ep"}, "boundary"},
		{"negative is invalid",
			models.TestCase{Type: "negative", Technique: "ep"}, "invalid"},
		{"a design-token check is a quality claim, not a happy path",
			models.TestCase{Type: "positive", Technique: "design"}, "quality"},
		{"contrast is a quality claim",
			models.TestCase{Type: "positive", Technique: "a11y"}, "quality"},
		{"a timing budget is a quality claim even when negative",
			models.TestCase{Type: "negative", Technique: "performance"}, "quality"},
		{"positive behaviour is happy",
			models.TestCase{Type: "positive", Technique: "scenario"}, "happy"},
		{"nothing recognisable is other, never silently happy",
			models.TestCase{Type: "", Technique: ""}, "other"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := classify(&tc.in); got != tc.want {
				t.Fatalf("classify = %q, want %q", got, tc.want)
			}
		})
	}
}

// Every bucket classify can return must have a section, or its cases would be
// counted in the total and rendered nowhere.
func TestEveryBucketHasASection(t *testing.T) {
	declared := map[string]bool{}
	for _, b := range coverageBuckets {
		declared[b.Key] = true
	}
	for _, key := range []string{"happy", "boundary", "invalid", "edge", "quality", "other"} {
		if !declared[key] {
			t.Errorf("classify can return %q but no section renders it", key)
		}
	}
}

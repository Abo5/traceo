// RELEASE GATE — the weakness corpus is ONE file, shared by both backends.
//
// go:embed cannot reach outside the Go module, so backend-go ships a copy of
// backend/app/data/weaknesses.json. A copy that is allowed to drift is worse
// than no copy at all: the two backends would then generate different cases and
// report different coverage from the same "corpus_version". This gate fails the
// build the moment the two files differ, and scripts/sync-weaknesses.sh is the
// one-line fix.
package tests_test

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"

	secmod "traceo/internal/modules/security"
)

const (
	goCatalogue     = "../internal/modules/security/data/weaknesses.json"
	pythonCatalogue = "../../backend/app/data/weaknesses.json"
)

func TestWeaknessCatalogueCopiesAreByteIdentical(t *testing.T) {
	goBytes, err := os.ReadFile(goCatalogue)
	if err != nil {
		t.Fatalf("the Go copy of the corpus is missing: %v", err)
	}
	pyBytes, err := os.ReadFile(pythonCatalogue)
	if os.IsNotExist(err) {
		// A Go-only checkout (the container image ships no Python tree) still
		// builds and runs; there is simply nothing to compare against.
		t.Skipf("no Python backend in this checkout (%s) — nothing to compare",
			filepath.Clean(pythonCatalogue))
	}
	if err != nil {
		t.Fatalf("cannot read %s: %v", pythonCatalogue, err)
	}
	if !bytes.Equal(goBytes, pyBytes) {
		t.Fatalf("the weakness corpus has diverged between the backends.\n"+
			"  python: %s (%d bytes)\n  go:     %s (%d bytes)\n"+
			"  fix:    ./scripts/sync-weaknesses.sh",
			pythonCatalogue, len(pyBytes), goCatalogue, len(goBytes))
	}
}

// The embedded corpus is what the running server serves; the file on disk is
// what a reviewer reads in the pull request. They must be the same document.
func TestEmbeddedCorpusMatchesTheShippedFile(t *testing.T) {
	raw, err := os.ReadFile(goCatalogue)
	if err != nil {
		t.Fatalf("read corpus: %v", err)
	}
	if !bytes.Contains(raw, []byte(`"version": "`+secmod.Version()+`"`)) {
		t.Fatalf("the embedded corpus reports version %q, which the file does not state",
			secmod.Version())
	}
	for _, w := range secmod.Weaknesses() {
		if !bytes.Contains(raw, []byte(`"id": "`+w.ID+`"`)) {
			t.Fatalf("embedded class %q is not in the shipped file", w.ID)
		}
	}
}

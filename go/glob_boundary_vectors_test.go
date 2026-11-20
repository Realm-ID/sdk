package realmid

import (
	"encoding/json"
	"os"
	"testing"
)

// Runs every case of sdk/testdata/glob-boundary-vectors/vectors.json against
// the canonical matcher (SPEC §10.2 boundary table, §11.4.1).
func TestSPEC10_2_GlobBoundaryVectors(t *testing.T) {
	raw, err := os.ReadFile("../testdata/glob-boundary-vectors/vectors.json")
	if err != nil {
		t.Fatalf("vector file unreadable: %v", err)
	}
	var f struct {
		Count   int          `json:"matcher_case_count"`
		Matcher []pmvMatcher `json:"matcher"`
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatalf("vector file unparseable: %v", err)
	}
	ran, failed := 0, 0
	for _, c := range f.Matcher {
		ran++
		if got := canonicalMatch(c.Pattern, c.Kind, c.Path); got != c.Match {
			failed++
			t.Errorf("%s: canonicalMatch(%q, %q, %q) = %v, want %v", c.ID, c.Pattern, c.Kind, c.Path, got, c.Match)
		}
	}
	t.Logf("glob-boundary-vectors go: ran %d, %d failed", ran, failed)
	if ran == 0 || ran != f.Count {
		t.Fatalf("ran %d cases, file declares %d", ran, f.Count)
	}
}

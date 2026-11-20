package realmid

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

func TestUsersList_KindAndVerifiedEmailState(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/tenants/t1/users", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"items": []any{
			map[string]any{"id": "u1", "kind": "human", "verified_email_state": "unverified_required"},
			map[string]any{"id": "u2"},
		}, "next_cursor": ""})
	})
	r := joinedViaRealm(t, mux)
	pg, err := r.Tenants.Users.List(context.Background(), "t1", nil).Page(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := pg.Items[0]; got.Kind != PrincipalHuman || got.VerifiedEmailState != VerifiedEmailStateUnverifiedRequired {
		t.Errorf("populated item decoded as %+v", got)
	}
	if got := pg.Items[1]; got.Kind != "" || got.VerifiedEmailState != "" {
		t.Errorf("item without the fields must decode to zero values: %+v", got)
	}
}

func TestUser_VerifiedEmailStateConstants(t *testing.T) {
	want := map[string]string{
		VerifiedEmailStateVerified:           "verified",
		VerifiedEmailStateUnverified:         "unverified",
		VerifiedEmailStateUnverifiedRequired: "unverified_required",
	}
	for got, w := range want {
		if got != w {
			t.Errorf("constant %q, want %q", got, w)
		}
	}
	out, _ := json.Marshal(User{ID: "u1"})
	if strings.Contains(string(out), "kind") || strings.Contains(string(out), "verified_email_state") {
		t.Errorf("unset fields must be omitted: %s", out)
	}
}

package realmid

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// joinedViaRealm builds a Realm against mux with a platform login stub.
func joinedViaRealm(t *testing.T, mux *http.ServeMux) *Realm {
	t.Helper()
	mux.HandleFunc("/auth/login", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "ok", "subject_type": "platform", "refresh_token": "rtok-platform", "access_token": "ptok", "expires_in": 300})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	r, err := NewRealm(Config{SessionStore: NewMemorySessionStore(), RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func TestUser_JoinedViaDecode(t *testing.T) {
	var u User
	if err := json.Unmarshal([]byte(`{"id":"u1","joined_via":"sso_domain","joined_via_domain":"acme.com"}`), &u); err != nil {
		t.Fatal(err)
	}
	if u.JoinedVia != JoinedViaSSODomain || u.JoinedViaDomain != "acme.com" {
		t.Errorf("got %+v", u)
	}
	out, _ := json.Marshal(User{ID: "u2", JoinedVia: JoinedViaUnknown})
	if strings.Contains(string(out), "joined_via_domain") {
		t.Errorf("joined_via_domain must be omitted when empty: %s", out)
	}
	want := map[JoinedVia]string{
		JoinedViaInvitation: "invitation", JoinedViaSSODomain: "sso_domain", JoinedViaOpenSignup: "open_signup",
		JoinedViaImport: "import", JoinedViaAdmin: "admin", JoinedViaOwner: "owner",
		JoinedViaService: "service", JoinedViaUnknown: "unknown",
	}
	for c, s := range want {
		if string(c) != s {
			t.Errorf("const %q != %q", c, s)
		}
	}
}

func TestUsersList_JoinedViaAndEmailDomainParams(t *testing.T) {
	mux := http.NewServeMux()
	var q string
	mux.HandleFunc("/tenants/t1/users", func(w http.ResponseWriter, r *http.Request) {
		q = r.URL.RawQuery
		_ = json.NewEncoder(w).Encode(map[string]any{"items": []any{map[string]any{"id": "u1", "joined_via": "import"}}, "next_cursor": ""})
	})
	r := joinedViaRealm(t, mux)
	pg, err := r.Tenants.Users.List(context.Background(), "t1", &UserListOpts{JoinedVia: JoinedViaImport, EmailDomain: "acme.com"}).Page(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, w := range []string{"joined_via=import", "email_domain=acme.com"} {
		if !strings.Contains(q, w) {
			t.Errorf("query %q missing %q", q, w)
		}
	}
	if pg.Items[0].JoinedVia != JoinedViaImport {
		t.Errorf("decoded %+v", pg.Items[0])
	}
	if _, err := r.Tenants.Users.List(context.Background(), "t1", nil).Page(context.Background(), nil); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(q, "joined_via") || strings.Contains(q, "email_domain") {
		t.Errorf("unset filters must send nothing: %q", q)
	}
}

func TestUsersBulkUpdateStatus(t *testing.T) {
	mux := http.NewServeMux()
	var got map[string]any
	var method string
	mux.HandleFunc("/tenants/t1/users/bulk-status", func(w http.ResponseWriter, r *http.Request) {
		method = r.Method
		b, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(b, &got)
		_, _ = w.Write([]byte(`{"results":[{"user_id":"u1","outcome":"updated"},{"user_id":"u2","outcome":"refused_owner"}]}`))
	})
	r := joinedViaRealm(t, mux)
	res, err := r.Tenants.Users.BulkUpdateStatus(context.Background(), "t1", []string{"u1", "u2"}, UserStatusSuspended)
	if err != nil {
		t.Fatal(err)
	}
	if method != "POST" {
		t.Errorf("method %s", method)
	}
	ids, _ := got["user_ids"].([]any)
	if len(ids) != 2 || got["status"] != "suspended" {
		t.Errorf("body %v", got)
	}
	if len(res.Results) != 2 || res.Results[0].UserID != "u1" || res.Results[0].Outcome != BulkOutcomeUpdated || res.Results[1].Outcome != BulkOutcomeRefusedOwner {
		t.Errorf("results %+v", res)
	}
	if _, err := r.Tenants.Users.BulkUpdateStatus(context.Background(), "t1", nil, UserStatusSuspended); err == nil {
		t.Error("empty ids must be refused locally")
	}
	if _, err := r.Tenants.Users.BulkUpdateStatus(context.Background(), "t1", []string{"u1"}, UserStatusActive); err == nil {
		t.Error("status active is not allowed by the contract")
	}
}

func TestDetach_SignOutParamOnlyWhenSet(t *testing.T) {
	mux := http.NewServeMux()
	var qs, methods []string
	h := func(w http.ResponseWriter, r *http.Request) {
		qs = append(qs, r.URL.RawQuery)
		methods = append(methods, r.Method)
		_, _ = w.Write([]byte(`{}`))
	}
	mux.HandleFunc("/platforms/p1/tenants/t1/domains/acme.com", h)
	mux.HandleFunc("/platforms/p1/origins/o1", h)
	r := joinedViaRealm(t, mux)
	ctx := context.Background()
	if err := r.Tenants.DetachDomain(ctx, "p1", "t1", "acme.com", nil); err != nil {
		t.Fatal(err)
	}
	if err := r.Tenants.DetachDomain(ctx, "p1", "t1", "acme.com", &DetachOptions{SignOut: true}); err != nil {
		t.Fatal(err)
	}
	if err := r.Origins.Delete(ctx, "p1", "o1", nil); err != nil {
		t.Fatal(err)
	}
	if err := r.Origins.Delete(ctx, "p1", "o1", &DetachOptions{SignOut: true}); err != nil {
		t.Fatal(err)
	}
	want := []string{"", "sign_out=true", "", "sign_out=true"}
	if len(qs) != len(want) {
		t.Fatalf("calls %d, want %d", len(qs), len(want))
	}
	for i := range want {
		if qs[i] != want[i] || methods[i] != "DELETE" {
			t.Errorf("call %d: %s %q, want DELETE %q", i, methods[i], qs[i], want[i])
		}
	}
}

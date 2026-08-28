package realmid

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"testing"
)

// ---- ADR-097 mint half: TokenRequest.Scope ----
//
// The enforcement half of ADR-097 (ScopesFrom / ScopeAllows / ScopePolicy)
// shipped in all three SDKs; the MINT half shipped in none of them, so
// `ScopePolicy` was reachable only by a partner who bypassed the SDK and
// called POST /auth/token by hand. These tests lock the operand onto the wire.

// TestAuth_TokenSendsScope is the defect test: before this field existed the
// body had no `scope` key at all, whatever the caller asked for.
func TestAuth_TokenSendsScope(t *testing.T) {
	var gotBody map[string]any
	srv := authTestServer(t, map[string]http.HandlerFunc{
		"/auth/token": func(w http.ResponseWriter, r *http.Request) {
			buf, _ := io.ReadAll(r.Body)
			_ = json.Unmarshal(buf, &gotBody)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"access_token": "atok", "refresh_token": "rtok", "expires_in": 900,
			})
		},
	})
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	if _, err := r.Auth.Token(context.Background(), TokenRequest{
		RefreshToken: "rtok",
		TenantID:     "t1",
		Scope:        []string{"orders:read", "orders:write"},
	}); err != nil {
		t.Fatalf("token: %v", err)
	}
	// Space-delimited, in the order given — RFC 6749 §3.3. Order is preserved
	// because ScopesFrom promises the issuer's order back to the verifier.
	if got, _ := gotBody["scope"].(string); got != "orders:read orders:write" {
		t.Errorf("scope on the wire = %q, want %q (body: %+v)", got, "orders:read orders:write", gotBody)
	}
}

// TestAuth_TokenOmitsAbsentScope keys omission on emptiness, NOT on nil.
//
// This is deliberately DIFFERENT from RolePermissions, which is nil-keyed
// because an empty supplied list is a real instruction there ("this role
// confers nothing here", answered with a 403). An empty `scope` has no such
// meaning: the issuer's parseScope trims and returns nil for "", so sending
// `"scope": ""` and omitting the key are indistinguishable server-side.
// Keying on nil would put a field on the wire that cannot mean anything.
func TestAuth_TokenOmitsAbsentScope(t *testing.T) {
	for _, tc := range []struct {
		name  string
		scope []string
	}{
		{"nil", nil},
		{"empty", []string{}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var gotBody map[string]any
			srv := authTestServer(t, map[string]http.HandlerFunc{
				"/auth/token": func(w http.ResponseWriter, r *http.Request) {
					buf, _ := io.ReadAll(r.Body)
					_ = json.Unmarshal(buf, &gotBody)
					_ = json.NewEncoder(w).Encode(map[string]any{
						"access_token": "atok", "refresh_token": "rtok", "expires_in": 900,
					})
				},
			})
			defer srv.Close()

			r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
			if _, err := r.Auth.Token(context.Background(), TokenRequest{
				RefreshToken: "rtok", TenantID: "t1", Scope: tc.scope,
			}); err != nil {
				t.Fatalf("token: %v", err)
			}
			if _, present := gotBody["scope"]; present {
				t.Errorf("scope key present for a %s scope: %+v", tc.name, gotBody)
			}
		})
	}
}

// TestAuth_TokenRefusesUnsendableScope is the reason Scope is []string and not
// a raw string.
//
// A SPACE inside one entry is not a parse error on the wire — it is a SILENT
// AUTHORITY CHANGE. `[]string{"orders read"}` joins to "orders read", which the
// issuer's strings.Fields reads as TWO scopes, minting authority the caller
// never asked for. Taking a list and refusing an unsendable entry client-side
// turns that into an error the partner sees at the call site.
//
// The charset is RFC 6749 §3.3 and is FIXED BY SPEC, not per-realm — which is
// what makes checking it here safe from drift. The per-realm bounds
// (max_permission_strings / max_permission_string_len) are deliberately NOT
// checked here: those ARE realm-configurable, so a client-side copy would
// refuse tokens the server would have accepted.
func TestAuth_TokenRefusesUnsendableScope(t *testing.T) {
	for _, tc := range []struct {
		name  string
		entry string
	}{
		{"embedded space splits into two scopes", "orders read"},
		{"tab is whitespace the issuer also splits on", "orders\tread"},
		{"double quote is outside the scope-token charset", `orders"read`},
		{"backslash is outside the scope-token charset", `orders\read`},
		{"empty entry cannot be represented at all", ""},
		{"del is not printable ASCII", "orders\x7f"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			reached := false
			srv := authTestServer(t, map[string]http.HandlerFunc{
				"/auth/token": func(w http.ResponseWriter, r *http.Request) {
					reached = true
					_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "atok"})
				},
			})
			defer srv.Close()

			r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
			_, err := r.Auth.Token(context.Background(), TokenRequest{
				RefreshToken: "rtok", TenantID: "t1",
				Scope: []string{"orders:read", tc.entry},
			})
			if !errors.Is(err, ErrInvalidScope) {
				t.Fatalf("err = %v, want ErrInvalidScope", err)
			}
			// The mint must not happen at all — a refusal that still spends the
			// refresh token would rotate it and log the caller out.
			if reached {
				t.Error("request reached the issuer; the refusal must be client-side")
			}
		})
	}
}

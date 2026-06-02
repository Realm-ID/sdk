package realmid

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// fakeCred is a test CredentialSource that returns a fixed credential.
type fakeCred struct{ c Credential }

func (f fakeCred) Fetch(_ context.Context) (Credential, error) { return f.c, nil }

// TestSession_TokenExchangeCredential asserts a workload CredentialSource makes
// the SDK post grant_type=token-exchange + subject_token to /auth/login
// (ADR-057), and that the minted platform token is cached the same way.
func TestSession_TokenExchangeCredential(t *testing.T) {
	var body map[string]any
	mux := http.NewServeMux()
	mux.HandleFunc("/auth/login", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&body)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"status": "ok", "subject_type": "platform",
			"refresh_token": "rt", "access_token": "at", "expires_in": 60,
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	r, err := NewRealm(Config{
		RealmID:    testRealmID,
		BaseURL:    srv.URL,
		Credential: fakeCred{c: Credential{GrantType: grantTokenExchange, SubjectToken: "workload.jwt.tok"}},
	})
	if err != nil {
		t.Fatalf("NewRealm: %v", err)
	}
	tok, err := r.platformToken.get(context.Background())
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if tok != "at" {
		t.Errorf("access token: got %q want %q", tok, "at")
	}
	if body["grant_type"] != grantTokenExchange {
		t.Errorf("grant_type: got %v want %v", body["grant_type"], grantTokenExchange)
	}
	if body["subject_token"] != "workload.jwt.tok" {
		t.Errorf("subject_token: got %v", body["subject_token"])
	}
	if body["subject_token_type"] != subjectTokenTypeJWT {
		t.Errorf("subject_token_type: got %v want %v", body["subject_token_type"], subjectTokenTypeJWT)
	}
	if _, ok := body["api_key"]; ok {
		t.Errorf("api_key must not be sent on a token-exchange login: %v", body["api_key"])
	}
}

// TestStaticAPIKey_Fetch covers the back-compat source.
func TestStaticAPIKey_Fetch(t *testing.T) {
	c, err := StaticAPIKey("rk_live_abc").Fetch(context.Background())
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if c.GrantType != grantPlatformAPIKey || c.APIKey != "rk_live_abc" {
		t.Fatalf("unexpected credential: %+v", c)
	}
	if _, err := StaticAPIKey("").Fetch(context.Background()); err == nil {
		t.Fatal("empty key should error")
	}
}

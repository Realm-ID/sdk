package realmid

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// exchangeBody mints once through a handle configured with cred and returns the
// request body the platform-token manager posted.
func exchangeBody(t *testing.T, cred CredentialSource, apiKey string) map[string]any {
	t.Helper()
	var body map[string]any
	mux := http.NewServeMux()
	mux.HandleFunc("/auth/token", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&body)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"status": "ok", "subject_type": "platform", "access_token": "at", "expires_in": 60,
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	r, err := NewRealm(Config{SessionStore: NewMemorySessionStore(), RealmID: testRealmID,
		BaseURL: srv.URL, Credential: cred, APIKey: apiKey})
	if err != nil {
		t.Fatalf("NewRealm: %v", err)
	}
	if _, err := r.platformToken.get(context.Background()); err != nil {
		t.Fatalf("get: %v", err)
	}
	return body
}

func TestTokenExchange_SendsHandleRealmAsPlatformID(t *testing.T) {
	body := exchangeBody(t, fakeCred{c: Credential{GrantType: grantTokenExchange, SubjectToken: "wl.jwt"}}, "")
	if body["platform_id"] != testRealmID {
		t.Errorf("platform_id: got %v want %v", body["platform_id"], testRealmID)
	}
}

func TestTokenExchange_CredentialPlatformIDWins(t *testing.T) {
	body := exchangeBody(t, fakeCred{c: Credential{GrantType: grantTokenExchange, SubjectToken: "wl.jwt", PlatformID: "plat-override"}}, "")
	if body["platform_id"] != "plat-override" {
		t.Errorf("platform_id: got %v want plat-override", body["platform_id"])
	}
}

func TestPlatformAPIKeyGrant_NeverSendsPlatformID(t *testing.T) {
	body := exchangeBody(t, nil, "rk_live_test")
	if _, ok := body["platform_id"]; ok {
		t.Errorf("platform_id must not be sent on the platform_api_key grant: %v", body["platform_id"])
	}
}

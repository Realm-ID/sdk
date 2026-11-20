package realmid

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// The issuer's Retry-After on a refusal the middleware answers is relayed to the browser.
func TestMiddleware_RelaysIssuerRetryAfterOnLogin(t *testing.T) {
	for _, tc := range []struct {
		status int
		code   string
		want   int
	}{
		{http.StatusTooManyRequests, "sign_in_ip_rate_limited", http.StatusTooManyRequests},
		{http.StatusServiceUnavailable, "server_error", http.StatusServiceUnavailable},
		// the middleware shows this refusal under a different status; the header still rides along
		{http.StatusForbidden, "escort_suspended", http.StatusServiceUnavailable},
	} {
		srv := mwTestServer(t, nil, testAud, map[string]http.HandlerFunc{
			"/auth/login": func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Retry-After", "37")
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(tc.status)
				_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]any{"code": tc.code, "message": "slow down"}})
			},
		})
		r, _ := NewRealm(Config{SessionStore: NewMemorySessionStore(), RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
		h := r.Middleware(MiddlewareOptions{TokenDelivery: "body"})(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(404) }))
		req := httptest.NewRequest("POST", "/login", strings.NewReader(`{"method":"firebase","provider_token":"pt"}`))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		srv.Close()
		if rec.Code != tc.want {
			t.Fatalf("status %d want %d: %s", rec.Code, tc.want, rec.Body.String())
		}
		if got := rec.Header().Get("Retry-After"); got != "37" {
			t.Errorf("status %d: Retry-After = %q, want 37 (body %s)", tc.status, got, rec.Body.String())
		}
	}
}

// The refresh route relays it too, including on a request answered from the stored shared outcome.
func TestMiddleware_RefreshRelaysIssuerRetryAfter(t *testing.T) {
	for _, status := range []int{http.StatusTooManyRequests, http.StatusServiceUnavailable} {
		var hits atomic.Int32
		srv := mwTestServer(t, nil, testAud, map[string]http.HandlerFunc{
			"/auth/token": func(w http.ResponseWriter, _ *http.Request) {
				// Only the first hit carries the header: a second answer that still has it came from storage.
				if hits.Add(1) == 1 {
					w.Header().Set("Retry-After", "21")
				}
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(status)
				_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]any{"code": "server_error", "message": "slow down"}})
			},
		})
		r, _ := NewRealm(Config{SessionStore: NewMemorySessionStore(), RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
		h := r.Middleware(MiddlewareOptions{})(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(404) }))
		for i := 0; i < 2; i++ { // second call: the stored outcome
			req := httptest.NewRequest("POST", "/token", strings.NewReader(`{"tenant_id":"t1"}`))
			req.Header.Set("Content-Type", "application/json")
			req.AddCookie(&http.Cookie{Name: "realmid_refresh", Value: "rt1"})
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			if rec.Code != status {
				t.Fatalf("call %d status %d want %d: %s", i, rec.Code, status, rec.Body.String())
			}
			if got := rec.Header().Get("Retry-After"); got != "21" {
				t.Errorf("call %d status %d: Retry-After = %q, want 21", i, status, got)
			}
		}
		if got := hits.Load(); got != 1 {
			t.Errorf("status %d: issuer /auth/token hits = %d, want 1 (the second answer must come from the stored outcome)", status, got)
		}
		srv.Close()
	}
}

// A stored refusal keeps the issuer's Retry-After through the JSON the shared store holds.
func TestRefreshOutcome_StoredErrRetryAfterRoundTrips(t *testing.T) {
	in := toStoredErr(&RealmError{Code: ErrCodeServerError, Message: "m", HTTPStatus: 429, RetryAfter: 21 * time.Second})
	raw, err := json.Marshal(&refreshOutcome{Fingerprint: "t1", Err: in})
	if err != nil {
		t.Fatal(err)
	}
	var out refreshOutcome
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	if got := out.Err.realmError().RetryAfter; got != 21*time.Second {
		t.Fatalf("RetryAfter = %v after round trip (%s), want 21s", got, raw)
	}
}

// The SDK's own key fetch is not a call made for the browser request: its Retry-After is not relayed.
func TestMiddleware_JWKSFetchRetryAfterIsNotRelayed(t *testing.T) {
	sign, _ := mintTestKey(t, "kid-1")
	mux := http.NewServeMux()
	mux.HandleFunc("/"+testRealmID+"/.well-known/jwks.json", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Retry-After", "30")
		w.WriteHeader(http.StatusServiceUnavailable)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	r, _ := NewRealm(Config{SessionStore: NewMemorySessionStore(), RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	h := r.Middleware(MiddlewareOptions{})(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(200) }))
	now := time.Now().Unix()
	tok := sign(map[string]any{"iss": srv.URL + "/" + testRealmID, "sub": "u1", "aud": testAud, "iat": now, "exp": now + 600})
	req := httptest.NewRequest("GET", "/me", nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code == 200 {
		t.Fatalf("expected a refusal, got 200")
	}
	if got := rec.Header().Get("Retry-After"); got != "" {
		t.Errorf("Retry-After = %q, want none (status %d, body %s)", got, rec.Code, rec.Body.String())
	}
}

func TestRespondAuthFailAndWriteRealmError_RelayRetryAfterOnly(t *testing.T) {
	r := &Realm{logger: noopLogger()}
	re := &RealmError{Code: ErrCodeServerError, Message: "m", HTTPStatus: 429, RetryAfter: 12 * time.Second}
	w := httptest.NewRecorder()
	r.respondAuthFail(w, httptest.NewRequest("GET", "/", nil), &MiddlewareOptions{}, stageVerify, re)
	if got := w.Header().Get("Retry-After"); got != "12" {
		t.Errorf("respondAuthFail Retry-After = %q", got)
	}
	w = httptest.NewRecorder()
	writeRealmError(w, re)
	if got := w.Header().Get("Retry-After"); got != "12" {
		t.Errorf("writeRealmError Retry-After = %q", got)
	}
	w = httptest.NewRecorder()
	writeRealmError(w, &RealmError{Code: ErrCodeUnauthorized, Message: "m", HTTPStatus: 401})
	if _, ok := w.Header()["Retry-After"]; ok {
		t.Errorf("no issuer Retry-After must produce none")
	}
}

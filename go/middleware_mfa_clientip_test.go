package realmid

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// Issuer middleware.go (c-01/c-02) puts POST /auth/mfa/verify and
// /auth/mfa/recovery on the per-IP public-auth limiter, keyed on
// X-On-Behalf-Of-IP when a platform-bearer caller supplies it. SDK SPEC §10.1
// steps 5 / 5a: the middleware forwards the end user's IP on both calls, so
// one partner server's egress IP is not every user's bucket.
func TestMiddlewareMFARoutesForwardEndUserIP(t *testing.T) {
	for _, c := range []struct {
		name, path, issuerPath string
		clientIP               func(*http.Request) string
		remote, want           string
	}{
		{"verify default RemoteAddr", "/mfa/verify", "/auth/mfa/verify", nil, "203.0.113.5:4444", "203.0.113.5"},
		{"recovery default RemoteAddr", "/mfa/recovery", "/auth/mfa/recovery", nil, "[2001:db8::7]:4444", "2001:db8::7"},
		{"verify ClientIP hook", "/mfa/verify", "/auth/mfa/verify",
			func(r *http.Request) string { return r.Header.Get("X-Real-IP") }, "10.0.0.1:1", "198.51.100.9"},
		{"recovery ClientIP hook", "/mfa/recovery", "/auth/mfa/recovery",
			func(r *http.Request) string { return r.Header.Get("X-Real-IP") }, "10.0.0.1:1", "198.51.100.9"},
	} {
		c := c
		t.Run(c.name, func(t *testing.T) {
			_, pub := mintTestKey(t, "kid-1")
			var mu sync.Mutex
			var got []string
			h := func(w http.ResponseWriter, r *http.Request) {
				mu.Lock()
				got = append(got, r.Header.Get("X-On-Behalf-Of-IP"))
				mu.Unlock()
				_ = json.NewEncoder(w).Encode(map[string]any{
					"access_token": "atok", "refresh_token": "rtok", "expires_in": 900,
					"user": map[string]any{"id": "u1"}, "tenants": []any{},
				})
			}
			srv := mwTestServer(t, []jwk{pub}, testAud, map[string]http.HandlerFunc{c.issuerPath: h})
			defer srv.Close()
			r, _ := NewRealm(Config{SessionStore: NewMemorySessionStore(), RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
			mw := r.Middleware(MiddlewareOptions{TokenDelivery: "body", RecoveryPath: "/mfa/recovery", ClientIP: c.clientIP})
			handler := mw(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(200) }))
			req := httptest.NewRequest("POST", c.path, strings.NewReader(`{"challenge_token":"c","code":"123456"}`))
			req.RemoteAddr = c.remote
			req.Header.Set("X-Real-IP", "198.51.100.9")
			// A spoofable header the SDK must never trust by itself.
			req.Header.Set("X-Forwarded-For", "192.0.2.66")
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, req)
			mu.Lock()
			defer mu.Unlock()
			if w.Code != 200 || len(got) != 1 || got[0] != c.want {
				t.Fatalf("status=%d issuer X-On-Behalf-Of-IP=%q, want %q (body %s)", w.Code, got, c.want, w.Body.String())
			}
		})
	}
}

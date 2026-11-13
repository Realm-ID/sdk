package realmid

// ADR-096 D4 (amendment 2026-11-13) on the general MFAProtectedPaths gate: when the issuer's
// POST /auth/mfa/challenge answers 412 mfa_registration_required, the middleware relays an ENROLL
// state with the issuer's token, never `mfa_required` with an empty token.

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// The wire shape is login's 412 (issuer mfaRequiredErr.Response, rendered by GoFr): every key nested
// INSIDE `error`, including mfa_challenge_token and tenant_id.
func mfaEnrollIssuer(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusPreconditionFailed)
	_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]any{
		"code":                "mfa_registration_required",
		"message":             "mfa registration required",
		"mfa_challenge_token": "enroll-tok-1",
		"tenant_id":           "t1",
		"methods":             []string{"totp"},
	}})
}

func TestMiddleware_MFAStale_RelaysRegistrationRequiredFromTheIssuer(t *testing.T) {
	sign, pub := mintTestKey(t, "kid-1")
	srv := mwTestServer(t, []jwk{pub}, testAud, map[string]http.HandlerFunc{"/auth/mfa/challenge": mfaEnrollIssuer})
	defer srv.Close()
	var logs bytes.Buffer
	r, _ := NewRealm(Config{SessionStore: NewMemorySessionStore(), RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL, Logger: newCapturingLogger(&logs)})
	mw := r.Middleware(MiddlewareOptions{MFAProtectedPaths: []MFARule{{Path: "/admin/*", MaxAge: 15 * time.Minute}}})
	now := time.Now().Unix()
	tok := sign(map[string]any{"iss": srv.URL + "/" + testRealmID, "sub": "u1", "aud": testAud, "iat": now, "exp": now + 600, "mfa_at": now - 1800})
	h := mw(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(200) }))
	req := httptest.NewRequest("GET", "/admin/users", nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusPreconditionFailed {
		t.Fatalf("status %d body %s", rec.Code, rec.Body.String())
	}
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if errCode(out) != "mfa_registration_required" {
		t.Errorf("code %q, want mfa_registration_required; body %s", errCode(out), rec.Body.String())
	}
	if out["mfa_challenge_token"] != "enroll-tok-1" {
		t.Errorf("mfa_challenge_token %v, want the issuer's enroll token", out["mfa_challenge_token"])
	}
	if m, _ := out["methods"].([]any); len(m) != 1 || m[0] != "totp" {
		t.Errorf("methods %v, want [totp]", out["methods"])
	}
	if out["reason"] != "stale_mfa" {
		t.Errorf("reason %v", out["reason"])
	}
	if strings.Contains(logs.String(), "unavailable") {
		t.Errorf("a 412 refusal was logged as 'unavailable': %s", logs.String())
	}
}

package realmid

import (
	"bytes"
	"crypto"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// SPEC14_8_integration (R47, R50, R67.2). The inbound shape {"pass": "..."} is [inferred].

func postPass(h http.Handler, pass string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("POST", "/realmid/integration-token", strings.NewReader(`{"pass":"`+pass+`"}`)))
	return rec
}

func TestIntegrationHandler_ForwardsPassInXUserTokenWithTargetPlatformToken(t *testing.T) {
	f := newFakeIssuer(t)
	f.on("/auth/token", func(w http.ResponseWriter, r *http.Request, body map[string]any) {
		jsonReply(w, 200, map[string]any{"access_token": "TARGET-AT", "expires_in": 600, "tenant_id": "t1", "role": "member"})
	})
	rec := postPass(NewIntegrationTokenHandler(f.realm(t, nil), IntegrationHandlerOptions{}), "ip_abc")
	var mint *seenReq
	for _, r := range f.reqs("/auth/token") {
		if r.Body["grant_type"] == "integration_installation" {
			r := r
			mint = &r
		}
	}
	if mint == nil {
		t.Fatalf("no integration_installation mint reached /auth/token; handler answered %d %s", rec.Code, rec.Body.String())
	}
	if mint.Auth != "Bearer ptok" || mint.UserToken != "ip_abc" {
		t.Errorf("mint auth=%q X-User-Token=%q; want target platform token + pass in X-User-Token", mint.Auth, mint.UserToken)
	}
	for k, v := range mint.Body {
		if s, _ := v.(string); strings.Contains(s, "ip_abc") {
			t.Errorf("pass leaked into body field %q (R67.2: header only)", k)
		}
	}
	if f.reqs("/auth/token/partial") != nil {
		t.Error("full target hit /auth/token/partial")
	}
}

func TestIntegrationHandler_FullTargetRelaysIssuerAnswerVerbatim(t *testing.T) {
	f := newFakeIssuer(t)
	f.on("/auth/token", func(w http.ResponseWriter, r *http.Request, body map[string]any) {
		jsonReply(w, 401, map[string]any{"error": map[string]any{"code": "install_pass_invalid", "message": "spent"}})
	})
	rec := postPass(NewIntegrationTokenHandler(f.realm(t, nil), IntegrationHandlerOptions{}), "ip_spent")
	if rec.Code != 401 || !strings.Contains(rec.Body.String(), "install_pass_invalid") {
		t.Errorf("relay: got %d %s, want the issuer's 401 install_pass_invalid verbatim", rec.Code, rec.Body.String())
	}
}

func TestIntegrationHandler_SplitTargetFinishesHalfSignedAnswer(t *testing.T) {
	k := newSplitKey(t, "split-1")
	f := newFakeIssuer(t)
	f.on("/auth/token/partial", func(w http.ResponseWriter, r *http.Request, body map[string]any) {
		jsonReply(w, 200, k.partialAnswer(t, userClaims(issuerOf(f)), ""))
	})
	r := f.realm(t, func(c *Config) { c.Split = true; c.ShareSource = &memShares{b: k.bundle(testRealmID)} })
	rec := postPass(NewIntegrationTokenHandler(r, IntegrationHandlerOptions{}), "ip_abc")
	var out struct {
		AccessToken string `json:"access_token"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil || out.AccessToken == "" {
		t.Fatalf("split target: %d %s", rec.Code, rec.Body.String())
	}
	parts := strings.Split(out.AccessToken, ".")
	sig, _ := base64.RawURLEncoding.DecodeString(parts[len(parts)-1])
	sum := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	if len(parts) != 3 || rsa.VerifyPKCS1v15(&k.priv.PublicKey, crypto.SHA256, sum[:], sig) != nil {
		t.Errorf("handler returned an unfinished or unverifiable token: %q", out.AccessToken)
	}
	pr := f.reqs("/auth/token/partial")
	if len(pr) != 1 || pr[0].UserToken != "ip_abc" || pr[0].Auth != "Bearer ptok" {
		t.Errorf("partial request: %+v", pr)
	}
}

func TestIntegrationHandler_RateLimitsBeforeCallingIssuer(t *testing.T) {
	f := newFakeIssuer(t)
	f.on("/auth/token", func(w http.ResponseWriter, r *http.Request, body map[string]any) {
		jsonReply(w, 200, map[string]any{"access_token": "AT", "expires_in": 600})
	})
	h := NewIntegrationTokenHandler(f.realm(t, nil), IntegrationHandlerOptions{RatePerMinute: 2})
	codes := []int{}
	for i := 0; i < 4; i++ {
		req := httptest.NewRequest("POST", "/x", bytes.NewReader([]byte(`{"pass":"ip_a"}`)))
		req.RemoteAddr = "198.51.100.7:4000"
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		_, _ = io.Copy(io.Discard, rec.Body)
		codes = append(codes, rec.Code)
	}
	if codes[0] != 200 || codes[1] != 200 || codes[2] != 429 || codes[3] != 429 {
		t.Errorf("status sequence = %v, want [200 200 429 429]", codes)
	}
	mints := 0
	for _, r := range f.reqs("/auth/token") {
		if r.Body["grant_type"] == "integration_installation" {
			mints++
		}
	}
	if mints != 2 {
		t.Errorf("issuer mints = %d, want 2 (limited requests must not reach it)", mints)
	}
}

func TestIntegrationHandler_RejectsNonPostAndMissingPassWithoutCallingIssuer(t *testing.T) {
	f := newFakeIssuer(t)
	h := NewIntegrationTokenHandler(f.realm(t, nil), IntegrationHandlerOptions{})
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/x", nil))
	if rec.Code != 405 {
		t.Errorf("GET = %d, want 405", rec.Code)
	}
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("POST", "/x", strings.NewReader(`{}`)))
	if rec.Code != 400 {
		t.Errorf("missing pass = %d, want 400", rec.Code)
	}
	for _, r := range f.reqs("/auth/token") {
		if r.Body["grant_type"] == "integration_installation" {
			t.Error("issuer called for a request with no pass")
		}
	}
}

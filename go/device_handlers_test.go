package realmid

// RED tests for SPEC §15 (device login handler set). Written before the implementation (W2-sdk);
// they compile against the signature-only stubs in device_handlers.go and fail on missing behaviour.

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"
)

// Compile-time pin (§1.0, owner 2026-11-02): the SA OTP login keeps its signatures.
var (
	_ func(*AuthClient, context.Context, ServiceAccountOTPLoginRequest) (*MintResult, error) = (*AuthClient).ServiceAccountOTPLogin
	_ func(*OTPClient, context.Context, IssueRequest) (*IssueResponse, error)                = (*OTPClient).Issue
)

const deviceURN = "urn:ietf:params:oauth:grant-type:device_code"

type devCall struct {
	Method, Path string
	Header       http.Header
	Body         map[string]any
}

// devIssuer is a fake issuer that records method, path, headers and JSON body of every request.
type devIssuer struct {
	t        *testing.T
	srv      *httptest.Server
	mu       sync.Mutex
	calls    []devCall
	handlers map[string]func(w http.ResponseWriter, r *http.Request, body map[string]any)
}

func newDevIssuer(t *testing.T) *devIssuer {
	t.Helper()
	d := &devIssuer{t: t, handlers: map[string]func(http.ResponseWriter, *http.Request, map[string]any){}}
	d.srv = httptest.NewServer(http.HandlerFunc(d.serve))
	t.Cleanup(d.srv.Close)
	return d
}

func (d *devIssuer) serve(w http.ResponseWriter, r *http.Request) {
	raw, _ := io.ReadAll(r.Body)
	var body map[string]any
	_ = json.Unmarshal(raw, &body)
	if r.URL.Path == "/auth/token" && body["grant_type"] == "platform_api_key" {
		jsonReply(w, 200, map[string]any{"status": "ok", "subject_type": "platform", "access_token": "ptok", "expires_in": 300})
		return
	}
	d.mu.Lock()
	d.calls = append(d.calls, devCall{r.Method, r.URL.Path, r.Header.Clone(), body})
	d.mu.Unlock()
	if h, ok := d.handlers[r.URL.Path]; ok {
		h(w, r, body)
		return
	}
	jsonReply(w, 404, map[string]any{"error": map[string]any{"code": "not_found", "message": r.URL.Path}})
}

func (d *devIssuer) on(path string, h func(w http.ResponseWriter, r *http.Request, body map[string]any)) {
	d.handlers[path] = h
}

func (d *devIssuer) reply(path string, status int, v any) {
	d.on(path, func(w http.ResponseWriter, _ *http.Request, _ map[string]any) { jsonReply(w, status, v) })
}

func (d *devIssuer) at(path string) []devCall {
	d.mu.Lock()
	defer d.mu.Unlock()
	var out []devCall
	for _, c := range d.calls {
		if c.Path == path {
			out = append(out, c)
		}
	}
	return out
}

func (d *devIssuer) total() int {
	d.mu.Lock()
	defer d.mu.Unlock()
	return len(d.calls)
}

func (d *devIssuer) realm(t *testing.T, mut func(*Config)) *Realm {
	t.Helper()
	cfg := Config{SessionStore: NewMemorySessionStore(), RealmID: testRealmID, APIKey: "rk", BaseURL: d.srv.URL, Origin: "https://app.example.com"}
	if mut != nil {
		mut(&cfg)
	}
	r, err := NewRealm(cfg)
	if err != nil {
		t.Fatalf("NewRealm: %v", err)
	}
	return r
}

const (
	pStart   = "/auth/device-authorizations"
	pInspect = "/auth/device-authorizations/inspect"
	pApprove = "/auth/device-authorizations/approve"
	pDeny    = "/auth/device-authorizations/deny"
)

func pendingAuth(extra map[string]any) map[string]any {
	m := map[string]any{
		"device_authorization_id": "da1", "status": "pending", "client_id": "traide-cli",
		"device_name": "build-box", "device_name_source": "client_declared", "subject_hint": "sync-bot",
		"reported_ip": "203.0.113.9", "reported_ip_source": "partner", "observed_ip": "10.0.0.1",
		"created_at": time.Now().UTC().Format(time.RFC3339), "expires_at": time.Now().Add(10 * time.Minute).UTC().Format(time.RFC3339),
	}
	for k, v := range extra {
		m[k] = v
	}
	return m
}

func baseDeviceOpts() DeviceOptions {
	return DeviceOptions{
		VerificationURI: "https://partner.example/device",
		CanApprove:      func(*http.Request, DeviceApprover, *DeviceRequest) bool { return true },
	}
}

func mustSet(t *testing.T, r *Realm, o DeviceOptions) *DeviceHandlerSet {
	t.Helper()
	s, err := DeviceHandlers(r, o)
	if err != nil {
		t.Fatalf("DeviceHandlers: %v", err)
	}
	return s
}

func freshClaims() *Claims {
	return &Claims{Subject: "u1", TenantID: "t1", SessionID: "s1", MFAAt: time.Now().Unix()}
}

// browserCall drives a browser-facing handler as an approver (claims in ctx, bearer "usertok").
func browserCall(h http.Handler, body any, c *Claims) *httptest.ResponseRecorder {
	b, _ := json.Marshal(body)
	req := httptest.NewRequest("POST", "/x", strings.NewReader(string(b)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer usertok")
	if c != nil {
		req = req.WithContext(context.WithValue(req.Context(), claimsKey, c))
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	return w
}

func decode(t *testing.T, w *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &m); err != nil {
		t.Fatalf("body is not JSON (status %d): %q", w.Code, w.Body.String())
	}
	return m
}

func errCode(m map[string]any) string {
	if e, ok := m["error"].(map[string]any); ok {
		s, _ := e["code"].(string)
		return s
	}
	return ""
}

// ---- constructor ----

func TestDevice_ConstructorRefusesAHalfBuiltSet(t *testing.T) {
	d := newDevIssuer(t)
	r := d.realm(t, nil)
	noURI := baseDeviceOpts()
	noURI.VerificationURI = ""
	noGate := baseDeviceOpts()
	noGate.CanApprove = nil
	badRule := baseDeviceOpts()
	badRule.ApproveStepUp = &MFARule{Path: ""}
	for name, o := range map[string]DeviceOptions{"no VerificationURI": noURI, "nil CanApprove": noGate, "invalid ApproveStepUp": badRule} {
		if s, err := DeviceHandlers(r, o); err == nil || s != nil {
			t.Errorf("%s: want (nil, error), got (%v, %v)", name, s, err)
		}
	}
}

func TestDevice_MountRegistersSixRoutesAtDefaultPaths(t *testing.T) {
	d := newDevIssuer(t)
	s := mustSet(t, d.realm(t, nil), baseDeviceOpts())
	mux := http.NewServeMux()
	s.Mount(mux, "/api")
	for _, p := range []string{"start", "token", "inspect", "approve", "deny", "signout"} {
		req := httptest.NewRequest("POST", "/api/device/"+p, strings.NewReader("{}"))
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, req)
		if w.Code == http.StatusNotFound {
			t.Errorf("POST /api/device/%s is not mounted (404)", p)
		}
	}
}

// ---- start ----

func TestDevice_StartForwardsFieldsAndDeviceIP(t *testing.T) {
	d := newDevIssuer(t)
	d.reply(pStart, 200, map[string]any{"device_authorization_id": "da1", "device_code": "dc", "user_code": "ABCD-EFGH", "expires_in": 600, "interval": 5})
	o := baseDeviceOpts()
	o.DeviceIP = func(*http.Request) string { return "198.51.100.7" }
	s := mustSet(t, d.realm(t, nil), o)
	form := url.Values{"client_id": {"traide-cli"}, "device_name": {"build-box"}, "subject_hint": {"sync-bot"}}
	req := httptest.NewRequest("POST", "/device/start", strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	w := httptest.NewRecorder()
	s.Start.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("status %d body %s", w.Code, w.Body.String())
	}
	got := d.at(pStart)
	if len(got) != 1 {
		t.Fatalf("issuer start calls = %d, want 1", len(got))
	}
	c := got[0]
	if c.Body["client_id"] != "traide-cli" || c.Body["device_name"] != "build-box" || c.Body["subject_hint"] != "sync-bot" {
		t.Errorf("start body = %v", c.Body)
	}
	if c.Header.Get("X-On-Behalf-Of-IP") != "198.51.100.7" {
		t.Errorf("X-On-Behalf-Of-IP = %q", c.Header.Get("X-On-Behalf-Of-IP"))
	}
	if c.Header.Get("Authorization") != "Bearer ptok" {
		t.Errorf("start bearer = %q, want the platform token", c.Header.Get("Authorization"))
	}
	m := decode(t, w)
	if m["verification_uri"] != "https://partner.example/device" || m["verification_uri_complete"] != "https://partner.example/device?code=ABCD-EFGH" {
		t.Errorf("verification uris = %v / %v", m["verification_uri"], m["verification_uri_complete"])
	}
	if m["device_code"] != "dc" || m["user_code"] != "ABCD-EFGH" {
		t.Errorf("RFC 8628 body missing: %v", m)
	}
}

func TestDevice_StartDefaultsDeviceIPToRemoteAddrHostAndCanOmitComplete(t *testing.T) {
	d := newDevIssuer(t)
	d.reply(pStart, 200, map[string]any{"device_code": "dc", "user_code": "ABCD-EFGH", "expires_in": 600, "interval": 5})
	o := baseDeviceOpts()
	o.OmitVerificationURIComplete = true
	s := mustSet(t, d.realm(t, nil), o)
	req := httptest.NewRequest("POST", "/device/start", strings.NewReader("device_name=x"))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.RemoteAddr = "192.0.2.44:5555"
	w := httptest.NewRecorder()
	s.Start.ServeHTTP(w, req)
	got := d.at(pStart)
	if len(got) != 1 || got[0].Header.Get("X-On-Behalf-Of-IP") != "192.0.2.44" {
		t.Fatalf("calls = %+v, want one call with IP 192.0.2.44", got)
	}
	if _, has := decode(t, w)["verification_uri_complete"]; has {
		t.Error("verification_uri_complete present despite OmitVerificationURIComplete")
	}
}

func TestDevice_StartRefusesOverlongClientIDLocally(t *testing.T) {
	d := newDevIssuer(t)
	s := mustSet(t, d.realm(t, nil), baseDeviceOpts())
	req := httptest.NewRequest("POST", "/device/start", strings.NewReader("client_id="+strings.Repeat("a", 65)))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	w := httptest.NewRecorder()
	s.Start.ServeHTTP(w, req)
	if w.Code != 400 || !strings.Contains(w.Body.String(), "invalid_client_id") {
		t.Errorf("status %d body %s, want 400 invalid_client_id", w.Code, w.Body.String())
	}
	if d.total() != 0 {
		t.Errorf("issuer was called %d times; the check is local", d.total())
	}
}

// ---- token (poll) ----

func tokenForm(grant string) *http.Request {
	req := httptest.NewRequest("POST", "/device/token", strings.NewReader(url.Values{"grant_type": {grant}, "device_code": {"dc1"}, "client_id": {"c"}}.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	return req
}

func TestDevice_TokenRequiresTheDeviceCodeGrant(t *testing.T) {
	d := newDevIssuer(t)
	s := mustSet(t, d.realm(t, nil), baseDeviceOpts())
	w := httptest.NewRecorder()
	s.Token.ServeHTTP(w, tokenForm("password"))
	if w.Code != 400 || decode(t, w)["error"] != "unsupported_grant_type" {
		t.Errorf("status %d body %s, want 400 {error: unsupported_grant_type}", w.Code, w.Body.String())
	}
	if d.total() != 0 {
		t.Errorf("issuer called for a wrong grant")
	}
}

func TestDevice_TokenForwardsDeviceCodeWithIPAndMapsRFCErrors(t *testing.T) {
	d := newDevIssuer(t)
	d.reply("/auth/token", 400, map[string]any{"error": map[string]any{"code": "slow_down", "message": "slow"}})
	o := baseDeviceOpts()
	o.DeviceIP = func(*http.Request) string { return "198.51.100.7" }
	s := mustSet(t, d.realm(t, nil), o)
	w := httptest.NewRecorder()
	s.Token.ServeHTTP(w, tokenForm(deviceURN))
	if w.Code != 400 || decode(t, w)["error"] != "slow_down" {
		t.Errorf("status %d body %s, want RFC 6749 body {error: slow_down}", w.Code, w.Body.String())
	}
	got := d.at("/auth/token")
	if len(got) != 1 || got[0].Body["grant_type"] != deviceURN || got[0].Body["device_code"] != "dc1" {
		t.Fatalf("issuer token call = %+v", got)
	}
	if got[0].Header.Get("X-On-Behalf-Of-IP") != "198.51.100.7" {
		t.Errorf("poll X-On-Behalf-Of-IP = %q", got[0].Header.Get("X-On-Behalf-Of-IP"))
	}
}

func TestDevice_TokenRelaysOtherIssuerCodesWithTheirStatus(t *testing.T) {
	d := newDevIssuer(t)
	d.reply("/auth/token", 403, map[string]any{"error": map[string]any{"code": "user_suspended", "message": "x"}})
	s := mustSet(t, d.realm(t, nil), baseDeviceOpts())
	w := httptest.NewRecorder()
	s.Token.ServeHTTP(w, tokenForm(deviceURN))
	if w.Code != 403 || decode(t, w)["error"] != "user_suspended" {
		t.Errorf("status %d body %s, want 403 {error: user_suspended} (R-CLI2)", w.Code, w.Body.String())
	}
}

// The poll's subject_type is strict: "user" is the self case, "service" the bot case, and anything else
// (missing, or a value this SDK does not know) is a server_error to the device, never a bot mint.
func TestDevice_TokenUnknownOrMissingSubjectTypeIsServerError(t *testing.T) {
	for name, st := range map[string]any{"missing": nil, "platform": "platform", "empty": ""} {
		t.Run(name, func(t *testing.T) {
			d := newDevIssuer(t)
			body := map[string]any{"status": "ok", "access_token": "at", "refresh_token": "rt",
				"expires_in": 900, "service_account_id": "sa1", "device_authorization_id": "da1"}
			if st != nil {
				body["subject_type"] = st
			}
			d.reply("/auth/token", 200, body)
			called := false
			o := baseDeviceOpts()
			o.OnIssued = func(*http.Request, DeviceTokens) (int, any, error) { called = true; return 200, nil, nil }
			s := mustSet(t, d.realm(t, nil), o)
			w := httptest.NewRecorder()
			s.Token.ServeHTTP(w, tokenForm(deviceURN))
			if w.Code != 500 || decode(t, w)["error"] != "server_error" || called || strings.Contains(w.Body.String(), "access_token") {
				t.Errorf("status %d body %s onIssued=%v, want 500 server_error and no token", w.Code, w.Body.String(), called)
			}
		})
	}
}

func TestDevice_TokenBotCaseDefaultsToRFC6749Response(t *testing.T) {
	d := newDevIssuer(t)
	d.reply("/auth/token", 200, map[string]any{"status": "ok", "subject_type": "service", "access_token": "at", "refresh_token": "rt",
		"expires_in": 900, "service_account_id": "sa1", "device_authorization_id": "da1"})
	s := mustSet(t, d.realm(t, nil), baseDeviceOpts())
	w := httptest.NewRecorder()
	s.Token.ServeHTTP(w, tokenForm(deviceURN))
	m := decode(t, w)
	if w.Code != 200 || m["access_token"] != "at" || m["token_type"] != "Bearer" || m["refresh_token"] != "rt" || m["expires_in"] != float64(900) {
		t.Errorf("status %d body %v, want {access_token, token_type: Bearer, expires_in, refresh_token}", w.Code, m)
	}
}

func TestDevice_OnIssuedShapesTheDeviceResponse(t *testing.T) {
	d := newDevIssuer(t)
	d.reply("/auth/token", 200, map[string]any{"status": "ok", "subject_type": "service", "access_token": "at", "refresh_token": "rt",
		"expires_in": 900, "service_account_id": "sa1", "device_authorization_id": "da1"})
	var seen DeviceTokens
	o := baseDeviceOpts()
	o.OnIssued = func(_ *http.Request, tk DeviceTokens) (int, any, error) {
		seen = tk
		return 201, map[string]any{"shaped": tk.Bot.AccessToken}, nil
	}
	s := mustSet(t, d.realm(t, nil), o)
	w := httptest.NewRecorder()
	s.Token.ServeHTTP(w, tokenForm(deviceURN))
	if w.Code != 201 || decode(t, w)["shaped"] != "at" {
		t.Errorf("status %d body %s, want OnIssued's 201 {shaped: at}", w.Code, w.Body.String())
	}
	if seen.SubjectType != "service" || seen.ServiceAccountID != "sa1" || seen.DeviceAuthorizationID != "da1" || seen.Bot == nil {
		t.Errorf("DeviceTokens = %+v", seen)
	}
}

func TestDevice_OnIssuedSelfCaseGetsDeviceLoginResult(t *testing.T) {
	d := newDevIssuer(t)
	d.reply("/auth/token", 200, map[string]any{"status": "ok", "subject_type": "user", "refresh_token": "rt", "user": map[string]any{"id": "u1"},
		"tenants": []any{}, "session_id": "s9", "device_authorization_id": "da1"})
	var seen DeviceTokens
	o := baseDeviceOpts()
	o.OnIssued = func(_ *http.Request, tk DeviceTokens) (int, any, error) {
		seen = tk
		return 200, map[string]any{"ok": true}, nil
	}
	s := mustSet(t, d.realm(t, nil), o)
	w := httptest.NewRecorder()
	s.Token.ServeHTTP(w, tokenForm(deviceURN))
	if seen.SubjectType != "user" || seen.Self == nil || seen.Bot != nil || seen.Self.RefreshToken != "rt" || seen.Self.SessionID != "s9" {
		t.Errorf("DeviceTokens = %+v (self case: Self set, Bot nil)", seen)
	}
}

func TestDevice_SplitRealmPollCoSignsAtPartialEndpoint(t *testing.T) {
	k := newSplitKey(t, "split-1")
	d := newDevIssuer(t)
	claims := map[string]any{"iss": strings.TrimRight(d.srv.URL, "/") + "/" + testRealmID, "sub": "sa1", "aud": testAud,
		"iat": time.Now().Unix(), "exp": time.Now().Unix() + 600}
	d.on("/auth/token/partial", func(w http.ResponseWriter, _ *http.Request, _ map[string]any) {
		a := k.partialAnswer(t, claims, "")
		a["subject_type"] = "service"
		a["service_account_id"] = "sa1"
		a["device_authorization_id"] = "da1"
		jsonReply(w, 200, a)
	})
	d.on("/auth/token", func(w http.ResponseWriter, _ *http.Request, _ map[string]any) {
		t.Errorf("a split realm polled /auth/token")
		jsonReply(w, 409, map[string]any{"error": map[string]any{"code": "split_signing_required"}})
	})
	r := d.realm(t, func(c *Config) { c.Split = true; c.ShareSource = &memShares{b: k.bundle(testRealmID)} })
	s := mustSet(t, r, baseDeviceOpts())
	w := httptest.NewRecorder()
	s.Token.ServeHTTP(w, tokenForm(deviceURN))
	at, _ := decode(t, w)["access_token"].(string)
	if w.Code != 200 || len(strings.Split(at, ".")) != 3 {
		t.Fatalf("status %d body %s, want a finished co-signed JWT", w.Code, w.Body.String())
	}
	if got := d.at("/auth/token/partial"); len(got) != 1 || got[0].Body["grant_type"] != deviceURN {
		t.Errorf("partial calls = %+v", got)
	}
}

// ---- browser-facing: gate ----

func browserRoutes(s *DeviceHandlerSet) map[string]http.Handler {
	return map[string]http.Handler{"inspect": s.Inspect, "approve": s.Approve, "deny": s.Deny, "signout": s.SignOut}
}

func TestDevice_BrowserRoutesNeedAnApprover(t *testing.T) {
	d := newDevIssuer(t)
	s := mustSet(t, d.realm(t, nil), baseDeviceOpts())
	for name, h := range browserRoutes(s) {
		w := browserCall(h, map[string]any{"userCode": "ABCD-EFGH"}, nil)
		if w.Code != 401 || errCode(decode(t, w)) != "unauthorized" {
			t.Errorf("%s without claims: status %d body %s, want 401 unauthorized", name, w.Code, w.Body.String())
		}
	}
	if d.total() != 0 {
		t.Errorf("issuer called %d times with no approver", d.total())
	}
}

func TestDevice_CanApproveFalseRefusesEarlyWithNoIssuerCall(t *testing.T) {
	d := newDevIssuer(t)
	var firstReqs []*DeviceRequest
	o := baseDeviceOpts()
	o.CanApprove = func(_ *http.Request, _ DeviceApprover, req *DeviceRequest) bool {
		firstReqs = append(firstReqs, req)
		return false
	}
	s := mustSet(t, d.realm(t, nil), o)
	for name, h := range browserRoutes(s) {
		firstReqs = nil
		w := browserCall(h, map[string]any{"userCode": "ABCD-EFGH"}, freshClaims())
		if w.Code != 403 || errCode(decode(t, w)) != "device_approval_not_allowed" {
			t.Errorf("%s: status %d body %s, want 403 device_approval_not_allowed", name, w.Code, w.Body.String())
		}
		if len(firstReqs) != 1 || firstReqs[0] != nil {
			t.Errorf("%s: CanApprove calls = %v, want exactly one with req == nil", name, firstReqs)
		}
	}
	if d.total() != 0 {
		t.Errorf("issuer was called %d times; the early refusal must precede every issuer call", d.total())
	}
}

func TestDevice_ClientIDReachesCanApproveAndResolveSubject(t *testing.T) {
	d := newDevIssuer(t)
	d.reply(pInspect, 200, pendingAuth(nil))
	var gateSaw, resolveSaw []string
	o := baseDeviceOpts()
	o.CanApprove = func(_ *http.Request, _ DeviceApprover, req *DeviceRequest) bool {
		if req != nil {
			gateSaw = append(gateSaw, req.ClientID)
		}
		return true
	}
	o.ResolveSubject = func(_ *http.Request, _ DeviceApprover, req DeviceRequest, _ bool) (DeviceSubject, error) {
		resolveSaw = append(resolveSaw, req.ClientID)
		return DeviceSubject{Ref: "user:sa1", Kind: "service", Label: "sync-bot in Acme"}, nil
	}
	s := mustSet(t, d.realm(t, nil), o)
	browserCall(s.Inspect, map[string]any{"userCode": "ABCD-EFGH"}, freshClaims())
	if len(gateSaw) != 1 || gateSaw[0] != "traide-cli" || len(resolveSaw) != 1 || resolveSaw[0] != "traide-cli" {
		t.Errorf("client_id at CanApprove = %v, at ResolveSubject = %v, want [traide-cli] each", gateSaw, resolveSaw)
	}
}

func TestDevice_RefusalAfterLookupIsTheIssuersOwn403Byte_For_Byte(t *testing.T) {
	d := newDevIssuer(t)
	const issuerBody = `{"error":{"code":"forbidden","message":"forbidden"}}` + "\n"
	d.on(pInspect, func(w http.ResponseWriter, _ *http.Request, _ map[string]any) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(403)
		_, _ = w.Write([]byte(issuerBody))
	})
	s := mustSet(t, d.realm(t, nil), baseDeviceOpts())
	unknown := browserCall(s.Inspect, map[string]any{"userCode": "ZZZZ-ZZZZ"}, freshClaims())

	d2 := newDevIssuer(t)
	d2.reply(pInspect, 200, pendingAuth(nil))
	o := baseDeviceOpts()
	o.CanApprove = func(_ *http.Request, _ DeviceApprover, req *DeviceRequest) bool { return req == nil }
	s2 := mustSet(t, d2.realm(t, nil), o)
	refused := browserCall(s2.Inspect, map[string]any{"userCode": "ABCD-EFGH"}, freshClaims())

	if unknown.Code != 403 || refused.Code != 403 || unknown.Body.String() != refused.Body.String() {
		t.Errorf("unknown code: %d %q; refused after lookup: %d %q — must be identical (Q2, no oracle)",
			unknown.Code, unknown.Body.String(), refused.Code, refused.Body.String())
	}
}

// ---- inspect view ----

func TestDevice_InspectBuildsTheCamelCaseViewWithoutLeakingHintOrObservedIP(t *testing.T) {
	d := newDevIssuer(t)
	d.reply(pInspect, 200, pendingAuth(nil))
	o := baseDeviceOpts()
	o.ReplaceExistingSessions = true
	o.ResolveSubject = func(_ *http.Request, _ DeviceApprover, _ DeviceRequest, preview bool) (DeviceSubject, error) {
		if !preview {
			t.Error("inspect must call ResolveSubject with preview=true")
		}
		return DeviceSubject{Kind: "service", Label: "sync-bot in Acme"}, nil
	}
	s := mustSet(t, d.realm(t, nil), o)
	w := browserCall(s.Inspect, map[string]any{"userCode": "abcd-efgh"}, freshClaims())
	m := decode(t, w)
	if w.Code != 200 || m["status"] != "pending" || m["clientId"] != "traide-cli" || m["deviceName"] != "build-box" ||
		m["deviceNameSource"] != "client_declared" || m["reportedIp"] != "203.0.113.9" || m["reportedIpSource"] != "partner" ||
		m["subjectType"] != "service" || m["subjectLabel"] != "sync-bot in Acme" || m["replaceExistingSessions"] != true || m["stepUp"] != true {
		t.Errorf("view = %v (status %d)", m, w.Code)
	}
	for _, leak := range []string{"subjectHint", "observedIp", "observed_ip", "subject_hint"} {
		if _, has := m[leak]; has {
			t.Errorf("view relays %q; it must not", leak)
		}
	}
	got := d.at(pInspect)
	if len(got) != 1 || got[0].Body["user_code"] != "abcd-efgh" || got[0].Header.Get("X-User-Token") != "usertok" || got[0].Header.Get("Authorization") != "Bearer ptok" {
		t.Errorf("issuer inspect call = %+v (user code sent as typed, actor in X-User-Token)", got)
	}
}

func TestDevice_RateLimitIsRelayedWithRetryAfter(t *testing.T) {
	d := newDevIssuer(t)
	d.on(pInspect, func(w http.ResponseWriter, _ *http.Request, _ map[string]any) {
		w.Header().Set("Retry-After", "120")
		jsonReply(w, 429, map[string]any{"error": map[string]any{"code": "device_code_attempts_exceeded", "message": "x"}})
	})
	s := mustSet(t, d.realm(t, nil), baseDeviceOpts())
	w := browserCall(s.Inspect, map[string]any{"userCode": "ABCD-EFGH"}, freshClaims())
	if w.Code != 429 || w.Header().Get("Retry-After") != "120" || errCode(decode(t, w)) != "device_code_attempts_exceeded" {
		t.Errorf("status %d Retry-After %q body %s", w.Code, w.Header().Get("Retry-After"), w.Body.String())
	}
}

// ---- approve ----

func approveIssuer(t *testing.T) *devIssuer {
	d := newDevIssuer(t)
	d.reply(pInspect, 200, pendingAuth(nil))
	d.on(pApprove, func(w http.ResponseWriter, _ *http.Request, body map[string]any) {
		if _, has := body["revoke_existing_sessions"]; !has {
			jsonReply(w, 400, map[string]any{"error": map[string]any{"code": "revoke_existing_sessions_required", "message": "x"}})
			return
		}
		jsonReply(w, 200, map[string]any{"device_authorization_id": "da1", "status": "approved", "subject_ref": "user:sa1", "subject_type": "service",
			"expires_at": time.Now().Add(time.Minute).UTC().Format(time.RFC3339)})
	})
	return d
}

func resolveBot(*http.Request, DeviceApprover, DeviceRequest, bool) (DeviceSubject, error) {
	return DeviceSubject{Ref: "user:sa1", Kind: "service", Label: "sync-bot"}, nil
}

func TestDevice_ApproveForwardsSubjectRefTenantAndActor(t *testing.T) {
	d := approveIssuer(t)
	o := baseDeviceOpts()
	o.ResolveSubject = resolveBot
	s := mustSet(t, d.realm(t, nil), o)
	w := browserCall(s.Approve, map[string]any{"userCode": "ABCD-EFGH", "tenantId": "t9", "revokeExistingSessions": false}, freshClaims())
	if w.Code != 200 || decode(t, w)["status"] != "approved" {
		t.Fatalf("status %d body %s", w.Code, w.Body.String())
	}
	got := d.at(pApprove)
	if len(got) != 1 {
		t.Fatalf("approve calls = %d", len(got))
	}
	b := got[0].Body
	if b["user_code"] != "ABCD-EFGH" || b["subject_ref"] != "user:sa1" || b["tenant_id"] != "t9" || b["revoke_existing_sessions"] != false {
		t.Errorf("approve body = %v", b)
	}
	if got[0].Header.Get("X-User-Token") != "usertok" || got[0].Header.Get("Authorization") != "Bearer ptok" {
		t.Errorf("approve headers = %v", got[0].Header)
	}
}

func TestDevice_ApproveSelfCaseDefaultsSubjectRefToSelf(t *testing.T) {
	d := approveIssuer(t)
	s := mustSet(t, d.realm(t, nil), baseDeviceOpts()) // ResolveSubject nil = self case
	browserCall(s.Approve, map[string]any{"userCode": "ABCD-EFGH", "revokeExistingSessions": true}, freshClaims())
	got := d.at(pApprove)
	if len(got) != 1 || got[0].Body["subject_ref"] != "self" {
		t.Errorf("approve calls = %+v, want subject_ref self", got)
	}
}

func TestDevice_ReplaceExistingSessionsForcesTrue(t *testing.T) {
	d := approveIssuer(t)
	o := baseDeviceOpts()
	o.ReplaceExistingSessions = true
	s := mustSet(t, d.realm(t, nil), o)
	for _, browser := range []map[string]any{
		{"userCode": "ABCD-EFGH", "revokeExistingSessions": false},
		{"userCode": "ABCD-EFGH"},
	} {
		browserCall(s.Approve, browser, freshClaims())
	}
	got := d.at(pApprove)
	if len(got) != 2 || got[0].Body["revoke_existing_sessions"] != true || got[1].Body["revoke_existing_sessions"] != true {
		t.Errorf("approve bodies = %+v, want revoke_existing_sessions true on both", got)
	}
}

func TestDevice_BrowserMustStateRevokeWhenNotForced(t *testing.T) {
	d := approveIssuer(t)
	s := mustSet(t, d.realm(t, nil), baseDeviceOpts())
	w := browserCall(s.Approve, map[string]any{"userCode": "ABCD-EFGH"}, freshClaims())
	if w.Code != 400 || errCode(decode(t, w)) != "revoke_existing_sessions_required" {
		t.Errorf("status %d body %s, want the issuer's 400 revoke_existing_sessions_required relayed", w.Code, w.Body.String())
	}
}

func TestDevice_OnBeforeApproveErrorAbortsBeforeTheIssuerApprove(t *testing.T) {
	cases := map[string]struct {
		err    error
		status int
		code   string
	}{
		"RealmError relayed": {&RealmError{Code: ErrCodeConflict, HTTPStatus: 409, Message: "no seat"}, 409, "conflict"},
		"plain error":        {io.ErrUnexpectedEOF, 500, "server_error"},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			d := approveIssuer(t)
			o := baseDeviceOpts()
			o.OnBeforeApprove = func(*http.Request, DeviceApprover, DeviceRequest) error { return c.err }
			s := mustSet(t, d.realm(t, nil), o)
			w := browserCall(s.Approve, map[string]any{"userCode": "ABCD-EFGH", "revokeExistingSessions": true}, freshClaims())
			if w.Code != c.status || errCode(decode(t, w)) != c.code {
				t.Errorf("status %d body %s, want %d %s", w.Code, w.Body.String(), c.status, c.code)
			}
			if n := len(d.at(pApprove)); n != 0 {
				t.Errorf("issuer approve called %d times after the hook refused", n)
			}
		})
	}
}

func TestDevice_ResolveSubjectBindsAfterOnBeforeApprove(t *testing.T) {
	d := approveIssuer(t)
	var order []string
	o := baseDeviceOpts()
	o.OnBeforeApprove = func(*http.Request, DeviceApprover, DeviceRequest) error { order = append(order, "before"); return nil }
	o.ResolveSubject = func(_ *http.Request, _ DeviceApprover, _ DeviceRequest, preview bool) (DeviceSubject, error) {
		if preview {
			order = append(order, "resolve-preview")
		} else {
			order = append(order, "resolve-bind")
		}
		return DeviceSubject{Ref: "user:sa1", Kind: "service"}, nil
	}
	s := mustSet(t, d.realm(t, nil), o)
	browserCall(s.Approve, map[string]any{"userCode": "ABCD-EFGH", "revokeExistingSessions": true}, freshClaims())
	if strings.Join(order, ",") != "before,resolve-bind" {
		t.Errorf("hook order = %v, want before,resolve-bind", order)
	}
}

func TestDevice_ApproveStepUpIsOnByDefault(t *testing.T) {
	d := approveIssuer(t)
	s := mustSet(t, d.realm(t, nil), baseDeviceOpts())
	stale := &Claims{Subject: "u1", TenantID: "t1", SessionID: "s1"} // no mfa_at
	w := browserCall(s.Approve, map[string]any{"userCode": "ABCD-EFGH", "revokeExistingSessions": true}, stale)
	if c := errCode(decode(t, w)); w.Code != 412 || (c != "mfa_required" && c != "mfa_registration_required") {
		t.Errorf("status %d body %s, want 412 mfa_required|mfa_registration_required", w.Code, w.Body.String())
	}
	if n := len(d.at(pApprove)); n != 0 {
		t.Errorf("issuer approve called %d times without a fresh MFA", n)
	}
	if _, has := decode(t, w)["mfa_challenge_token"]; !has {
		t.Error("412 envelope lacks the sibling mfa_challenge_token the step-up client reads")
	}
}

func TestDevice_ApproveStepUpOffViaOptsAndOverridable(t *testing.T) {
	stale := &Claims{Subject: "u1", TenantID: "t1", SessionID: "s1"}
	body := map[string]any{"userCode": "ABCD-EFGH", "revokeExistingSessions": true}

	d := approveIssuer(t)
	o := baseDeviceOpts()
	o.DisableApproveStepUp = true
	if w := browserCall(mustSet(t, d.realm(t, nil), o).Approve, body, stale); w.Code != 200 {
		t.Errorf("DisableApproveStepUp: status %d body %s, want 200", w.Code, w.Body.String())
	}

	d2 := approveIssuer(t)
	o2 := baseDeviceOpts()
	o2.ApproveStepUp = &MFARule{Path: "/device/approve", MaxAge: time.Hour}
	ten := &Claims{Subject: "u1", TenantID: "t1", SessionID: "s1", MFAAt: time.Now().Add(-30 * time.Minute).Unix()}
	if w := browserCall(mustSet(t, d2.realm(t, nil), o2).Approve, body, ten); w.Code != 200 {
		t.Errorf("ApproveStepUp MaxAge 1h with a 30-minute-old MFA: status %d body %s, want 200", w.Code, w.Body.String())
	}
}

// ---- deny and sign-out ----

func TestDevice_DenyForwardsWithActor(t *testing.T) {
	d := newDevIssuer(t)
	d.reply(pDeny, 200, map[string]any{"device_authorization_id": "da1", "status": "denied"})
	s := mustSet(t, d.realm(t, nil), baseDeviceOpts())
	w := browserCall(s.Deny, map[string]any{"userCode": "ABCD-EFGH"}, freshClaims())
	got := d.at(pDeny)
	if w.Code != 200 || decode(t, w)["status"] != "denied" || len(got) != 1 || got[0].Header.Get("X-User-Token") != "usertok" {
		t.Errorf("status %d body %s calls %+v", w.Code, w.Body.String(), got)
	}
}

func TestDevice_SignOutBotRevokesTheServiceAccount(t *testing.T) {
	d := newDevIssuer(t)
	d.reply(pInspect, 200, pendingAuth(map[string]any{"status": "collected", "subject_ref": "user:sa1", "subject_type": "service", "collected_session_id": "sx"}))
	d.reply("/tenants/t1/service-accounts/sa1/revoke", 200, map[string]any{"status": "ok"})
	s := mustSet(t, d.realm(t, nil), baseDeviceOpts())
	w := browserCall(s.SignOut, map[string]any{"userCode": "ABCD-EFGH"}, freshClaims())
	m := decode(t, w)
	if w.Code != 200 || m["subjectType"] != "service" || m["scope"] != "account" {
		t.Errorf("status %d body %s, want {subjectType: service, scope: account}", w.Code, w.Body.String())
	}
	got := d.at("/tenants/t1/service-accounts/sa1/revoke")
	if len(got) != 1 || got[0].Method != "POST" || got[0].Header.Get("X-User-Token") != "usertok" {
		t.Errorf("revoke calls = %+v", got)
	}
}

func TestDevice_SignOutSelfDeletesTheCollectedSession(t *testing.T) {
	d := newDevIssuer(t)
	d.reply(pInspect, 200, pendingAuth(map[string]any{"status": "collected", "subject_ref": "self", "subject_type": "user", "collected_session_id": "sx"}))
	d.reply("/auth/sessions/sx", 200, map[string]any{"status": "ok"})
	s := mustSet(t, d.realm(t, nil), baseDeviceOpts())
	w := browserCall(s.SignOut, map[string]any{"userCode": "ABCD-EFGH"}, freshClaims())
	m := decode(t, w)
	got := d.at("/auth/sessions/sx")
	if w.Code != 200 || m["subjectType"] != "user" || m["scope"] != "session" || len(got) != 1 || got[0].Method != "DELETE" {
		t.Errorf("status %d body %s calls %+v, want DELETE /auth/sessions/sx and scope session", w.Code, w.Body.String(), got)
	}
}

func TestDevice_SignOutBeforeCollectionIs409(t *testing.T) {
	d := newDevIssuer(t)
	d.reply(pInspect, 200, pendingAuth(map[string]any{"status": "approved", "subject_ref": "user:sa1", "subject_type": "service"}))
	s := mustSet(t, d.realm(t, nil), baseDeviceOpts())
	w := browserCall(s.SignOut, map[string]any{"userCode": "ABCD-EFGH"}, freshClaims())
	if w.Code != 409 || errCode(decode(t, w)) != "device_authorization_not_pending" {
		t.Errorf("status %d body %s, want 409 device_authorization_not_pending", w.Code, w.Body.String())
	}
	if d.total() != 1 {
		t.Errorf("issuer calls = %d, want only the inspect", d.total())
	}
}

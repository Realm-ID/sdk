package realmid

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"testing"
)

// SPEC §X.4a: POST /auth/otp/send-login, platform bearer, BARE 202 body
// (the issuer handler returns raw(...), not {"data":…} — ADR-116 appendix).
func TestAuth_SendLoginCode_RequestShapeAndBareBody(t *testing.T) {
	var gotBody map[string]any
	var gotAuth, gotIP, gotMethod string
	srv := authTestServer(t, map[string]http.HandlerFunc{
		"/auth/otp/send-login": func(w http.ResponseWriter, r *http.Request) {
			gotMethod, gotAuth, gotIP = r.Method, r.Header.Get("Authorization"), r.Header.Get("X-On-Behalf-Of-IP")
			buf, _ := io.ReadAll(r.Body)
			_ = json.Unmarshal(buf, &gotBody)
			w.WriteHeader(http.StatusAccepted)
			_, _ = w.Write([]byte(`{"sent_if_registered":true}`))
		},
	})
	defer srv.Close()
	r, _ := NewRealm(Config{SessionStore: NewMemorySessionStore(), RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	out, err := r.Auth.SendLoginCode(context.Background(), SendLoginCodeRequest{
		Identifier: "+919999000011", DeliveryMode: DeliveryModeSMS,
		TenantID: "t-1", OnBehalfOfIP: "203.0.113.9",
	})
	if err != nil {
		t.Fatalf("SendLoginCode: %v", err)
	}
	if out == nil || !out.SentIfRegistered {
		t.Fatalf("response = %+v, want SentIfRegistered true", out)
	}
	if gotMethod != "POST" || gotAuth != "Bearer ptok" || gotIP != "203.0.113.9" {
		t.Errorf("method=%q auth=%q ip=%q", gotMethod, gotAuth, gotIP)
	}
	if gotBody["identifier"] != "+919999000011" || gotBody["delivery_mode"] != "sms" || gotBody["tenant_id"] != "t-1" {
		t.Errorf("body = %v", gotBody)
	}
	if _, ok := gotBody["realm_id"]; ok {
		t.Errorf("body must not carry realm_id (the token's realm is used): %v", gotBody)
	}
}

func TestAuth_SendLoginCode_OmitsOptionalFields(t *testing.T) {
	var gotBody map[string]any
	hasIP := true
	srv := authTestServer(t, map[string]http.HandlerFunc{
		"/auth/otp/send-login": func(w http.ResponseWriter, r *http.Request) {
			_, hasIP = r.Header["X-On-Behalf-Of-Ip"]
			buf, _ := io.ReadAll(r.Body)
			_ = json.Unmarshal(buf, &gotBody)
			w.WriteHeader(http.StatusAccepted)
			_, _ = w.Write([]byte(`{"sent_if_registered":true}`))
		},
	})
	defer srv.Close()
	r, _ := NewRealm(Config{SessionStore: NewMemorySessionStore(), RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	if _, err := r.Auth.SendLoginCode(context.Background(), SendLoginCodeRequest{
		Identifier: "+919999000011", DeliveryMode: DeliveryModeWhatsApp,
	}); err != nil {
		t.Fatalf("SendLoginCode: %v", err)
	}
	if hasIP {
		t.Error("X-On-Behalf-Of-IP sent although OnBehalfOfIP was empty")
	}
	if _, ok := gotBody["tenant_id"]; ok {
		t.Errorf("tenant_id sent although empty: %v", gotBody)
	}
}

func sendLoginErr(t *testing.T, status int, body string) error {
	t.Helper()
	srv := authTestServer(t, map[string]http.HandlerFunc{
		"/auth/otp/send-login": func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(status)
			_, _ = w.Write([]byte(body))
		},
	})
	t.Cleanup(srv.Close)
	r, _ := NewRealm(Config{SessionStore: NewMemorySessionStore(), RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	_, err := r.Auth.SendLoginCode(context.Background(), SendLoginCodeRequest{Identifier: "+919999000011", DeliveryMode: DeliveryModeSMS})
	if err == nil {
		t.Fatal("want an error")
	}
	return err
}

// SPEC §3.1: the three ADR-116 codes are registered, so they land on .Code and
// are not duplicated into details.server_code.
func TestSendLoginCode_RegisteredCodes(t *testing.T) {
	cases := []struct {
		status int
		code   ErrorCode
		is     func(error) bool
	}{
		{429, ErrCodeSignInIPRateLimited, IsSignInIPRateLimited},
		{403, ErrCodeMethodNotEnabled, nil},
		{400, ErrCodeInvalidOnBehalfOfIP, nil},
	}
	for _, c := range cases {
		err := sendLoginErr(t, c.status, `{"error":{"code":"`+string(c.code)+`","message":"m"}}`)
		if !IsCode(err, c.code) {
			t.Errorf("%s: err = %v, want .Code %s", c.code, err, c.code)
		}
		if c.is != nil && !c.is(err) {
			t.Errorf("%s: helper false", c.code)
		}
		if re, ok := err.(*RealmError); ok {
			if _, dup := re.Details["server_code"]; dup {
				t.Errorf("%s duplicated into details.server_code: %v", c.code, re.Details)
			}
		}
	}
}

// method_not_enabled is a BEHAVIOUR CHANGE (owner ruling 2026-10-18): it also
// ships on the ADR-094 domain-SSO routes (400), and now lands on .Code there.
func TestMethodNotEnabled_NowOnCodeNotServerCode(t *testing.T) {
	err := sendLoginErr(t, 400, `{"error":{"code":"method_not_enabled","message":"off"}}`)
	re := err.(*RealmError)
	if re.Code != ErrCodeMethodNotEnabled {
		t.Errorf("Code = %q", re.Code)
	}
	if _, ok := re.Details["server_code"]; ok {
		t.Errorf("method_not_enabled still copied to details.server_code: %v", re.Details)
	}
}

func TestIsSignInIPRateLimited_FalseOnOthers(t *testing.T) {
	if IsSignInIPRateLimited(nil) {
		t.Error("nil")
	}
	err := sendLoginErr(t, 429, `{"error":{"code":"phone_otp_rate_limited","message":"m"}}`)
	if IsSignInIPRateLimited(err) {
		t.Error("phone_otp_rate_limited is not sign_in_ip_rate_limited")
	}
}

// delivery_unavailable stays UNREGISTERED, so the helper reads .Code OR
// details.server_code.
func TestIsDeliveryUnavailable(t *testing.T) {
	err := sendLoginErr(t, 503, `{"error":{"code":"delivery_unavailable","message":"m"},"channel":"sms"}`)
	if !IsDeliveryUnavailable(err) {
		t.Errorf("want true for delivery_unavailable: %v", err)
	}
	if !IsDeliveryUnavailable(&RealmError{Code: "delivery_unavailable"}) {
		t.Error("want true when it is on .Code")
	}
	if IsDeliveryUnavailable(sendLoginErr(t, 503, `{"error":{"code":"store_unavailable","message":"m"}}`)) {
		t.Error("store_unavailable is not delivery_unavailable")
	}
	if IsDeliveryUnavailable(nil) {
		t.Error("nil")
	}
}

func TestPhoneOTPConfig_SignInPerIPPerHour(t *testing.T) {
	v := ConfigValues{"phone_otp": map[string]any{
		"max_per_window": float64(5), "window_seconds": float64(900), "sign_in_per_ip_per_hour": float64(10),
	}}
	got := v.PhoneOTP()
	if got == nil || got.SignInPerIPPerHour != 10 {
		t.Fatalf("PhoneOTP() = %+v", got)
	}
}

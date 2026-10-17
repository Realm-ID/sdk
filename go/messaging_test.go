package realmid

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

// SPEC6_16 / SPEC3_1_channels / SPEC4_1_4a / SPECX_1_whatsapp / SPEC6_5_phone_otp
// (issuer ADR-115, spec 0.60.0). The issuer answers the messaging routes with a
// BARE body (raw(...)), not the {"data":...} envelope.

const messagingPath = "/platforms/" + testRealmID + "/messaging/"

func messagingRealm(t *testing.T, h http.HandlerFunc) *Realm {
	t.Helper()
	mux := http.NewServeMux()
	mintPlatformToken(mux)
	mux.HandleFunc(messagingPath, h)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	r, err := NewRealm(Config{SessionStore: NewMemorySessionStore(), RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func TestMessaging_PutSMS_SendsTwilioFieldsAndDecodesReadShape(t *testing.T) {
	var gotMethod, gotPath, gotAuth string
	var gotBody map[string]any
	r := messagingRealm(t, func(w http.ResponseWriter, req *http.Request) {
		gotMethod, gotPath, gotAuth = req.Method, req.URL.Path, req.Header.Get("Authorization")
		b, _ := io.ReadAll(req.Body)
		_ = json.Unmarshal(b, &gotBody)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"channel": "sms", "provider": "twilio", "secret_hint": "c0de",
			"status": "operational", "status_reason": nil,
			"status_changed_at": "2026-10-17T10:00:00Z", "validated_at": "2026-10-17T10:00:00Z",
			"updated_at":  "2026-10-17T10:00:00Z",
			"account_sid": "AC1", "api_key_sid": "SK1", "from_number": "+15551234567",
		})
	})
	got, err := r.Messaging.PutSMS(context.Background(), TwilioChannel{
		AccountSID: "AC1", APIKeySID: "SK1", APIKeySecret: "shh-c0de", FromNumber: "+15551234567",
	})
	if err != nil {
		t.Fatalf("PutSMS: %v", err)
	}
	if gotMethod != "PUT" || gotPath != messagingPath+"sms" || gotAuth != "Bearer ptok" {
		t.Errorf("request = %s %s auth=%q", gotMethod, gotPath, gotAuth)
	}
	want := map[string]any{"account_sid": "AC1", "api_key_sid": "SK1", "api_key_secret": "shh-c0de", "from_number": "+15551234567"}
	if !reflect.DeepEqual(gotBody, want) {
		t.Errorf("body = %v, want %v (unset fields must be omitted)", gotBody, want)
	}
	if got.Channel != MessagingChannelSMS || got.Provider != "twilio" || got.SecretHint != "c0de" ||
		got.Status != MessagingStatusOperational || got.StatusReason != nil || got.FromNumber != "+15551234567" ||
		got.ValidatedAt == nil || got.UpdatedAt.IsZero() {
		t.Errorf("read shape = %+v", got)
	}
}

func TestMessaging_PutWhatsApp_SendsMetaFields(t *testing.T) {
	var gotPath string
	var gotBody map[string]any
	r := messagingRealm(t, func(w http.ResponseWriter, req *http.Request) {
		gotPath = req.URL.Path
		b, _ := io.ReadAll(req.Body)
		_ = json.Unmarshal(b, &gotBody)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"channel": "whatsapp", "provider": "meta", "secret_hint": "9xyz", "status": "operational",
			"updated_at": "2026-10-17T10:00:00Z", "status_changed_at": "2026-10-17T10:00:00Z",
			"phone_number_id": "109", "waba_id": "22", "template_name": "login_code", "template_language": "en",
		})
	})
	got, err := r.Messaging.PutWhatsApp(context.Background(), WhatsAppChannel{
		PhoneNumberID: "109", WABAID: "22", AccessToken: "EAAG-9xyz", TemplateName: "login_code", TemplateLanguage: "en",
	})
	if err != nil {
		t.Fatalf("PutWhatsApp: %v", err)
	}
	if gotPath != messagingPath+"whatsapp" {
		t.Errorf("path = %q", gotPath)
	}
	for _, k := range []string{"phone_number_id", "waba_id", "access_token", "template_name", "template_language"} {
		if _, ok := gotBody[k]; !ok {
			t.Errorf("body lacks %s: %v", k, gotBody)
		}
	}
	if got.Channel != MessagingChannelWhatsApp || got.WABAID != "22" || got.TemplateLanguage != "en" {
		t.Errorf("read shape = %+v", got)
	}
}

// Secrets live on the write types only. A read type with a secret field could
// be re-serialised by a BFF and leak one; assert none exists by name.
func TestMessaging_ReadTypeHasNoSecretField(t *testing.T) {
	rt := reflect.TypeOf(MessagingChannel{})
	for i := 0; i < rt.NumField(); i++ {
		n := strings.ToLower(rt.Field(i).Name + " " + rt.Field(i).Tag.Get("json"))
		for _, bad := range []string{"secret ", "token", "api_key_secret", "apikeysecret"} {
			if strings.Contains(n, bad) && rt.Field(i).Name != "SecretHint" {
				t.Errorf("MessagingChannel has a secret-looking field %q", rt.Field(i).Name)
			}
		}
	}
	for _, w := range []reflect.Type{reflect.TypeOf(TwilioChannel{}), reflect.TypeOf(WhatsAppChannel{})} {
		if w.Kind() != reflect.Struct {
			t.Fatalf("%v not a struct", w)
		}
	}
}

func TestMessaging_GetNotConfigured_IsRegisteredCode(t *testing.T) {
	r := messagingRealm(t, func(w http.ResponseWriter, req *http.Request) {
		if req.Method != "GET" || req.URL.Path != messagingPath+"whatsapp" {
			t.Errorf("request = %s %s", req.Method, req.URL.Path)
		}
		w.WriteHeader(404)
		_, _ = w.Write([]byte(`{"error":{"code":"channel_not_configured","message":"no credentials are configured for this channel"}}`))
	})
	_, err := r.Messaging.Get(context.Background(), MessagingChannelWhatsApp)
	if !IsChannelNotConfigured(err) {
		t.Fatalf("err = %v, want channel_not_configured", err)
	}
	var re *RealmError
	if !errors.As(err, &re) || re.Code != ErrCodeChannelNotConfigured || re.HTTPStatus != 404 {
		t.Errorf("RealmError = %+v", re)
	}
	if _, dup := re.Details["server_code"]; dup {
		t.Errorf("a registered code must not be duplicated into details.server_code: %v", re.Details)
	}
}

func TestMessaging_Delete_ReturnsStatus(t *testing.T) {
	r := messagingRealm(t, func(w http.ResponseWriter, req *http.Request) {
		if req.Method != "DELETE" || req.URL.Path != messagingPath+"sms" {
			t.Errorf("request = %s %s", req.Method, req.URL.Path)
		}
		_, _ = w.Write([]byte(`{"status":"deleted"}`))
	})
	out, err := r.Messaging.Delete(context.Background(), MessagingChannelSMS)
	if err != nil || out.Status != "deleted" {
		t.Fatalf("Delete = %+v, %v", out, err)
	}
}

func TestMessaging_RejectsUnknownChannelBeforeTheNetwork(t *testing.T) {
	r := messagingRealm(t, func(w http.ResponseWriter, req *http.Request) {
		t.Errorf("no request expected, got %s %s", req.Method, req.URL.Path)
	})
	if _, err := r.Messaging.Get(context.Background(), "voice"); err == nil {
		t.Fatal("want an error for channel \"voice\"")
	}
	if _, err := r.Messaging.Delete(context.Background(), "../config"); err == nil {
		t.Fatal("want an error for a path-shaped channel")
	}
}

func TestMessaging_PutErrors_LandOnRegisteredCodes(t *testing.T) {
	cases := []struct {
		name   string
		status int
		code   string
		want   ErrorCode
		is     func(error) bool
	}{
		{"invalid", 400, "invalid_channel_config", ErrCodeInvalidChannelConfig, IsInvalidChannelConfig},
		{"validation", 422, "channel_validation_failed", ErrCodeChannelValidationFailed, IsChannelValidationFailed},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := messagingRealm(t, func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(c.status)
				_, _ = w.Write([]byte(`{"error":{"code":"` + c.code + `","message":"from_number: must be E.164"}}`))
			})
			_, err := r.Messaging.PutSMS(context.Background(), TwilioChannel{AccountSID: "AC1"})
			var re *RealmError
			if !errors.As(err, &re) || re.Code != c.want || !c.is(err) {
				t.Fatalf("err = %v, want code %s", err, c.want)
			}
			if !strings.Contains(re.Message, "E.164") {
				t.Errorf("the issuer's reason must survive in Message: %q", re.Message)
			}
		})
	}
}

// SPEC3_1_channels: phone_otp_rate_limited is registered, so it lands on .Code
// and is distinguishable from the generic 429 rate_limited.
func TestPhoneOTPRateLimited_Registered(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/auth/login", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "ok", "subject_type": "platform", "refresh_token": "r", "access_token": "ptok", "expires_in": 300})
	})
	mux.HandleFunc("/auth/otp/issue", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Retry-After", "120")
		w.WriteHeader(429)
		_, _ = w.Write([]byte(`{"error":{"code":"phone_otp_rate_limited","message":"too many codes sent to this number"}}`))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	r, _ := NewRealm(Config{SessionStore: NewMemorySessionStore(), RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	_, err := r.OTP.Issue(context.Background(), IssueRequest{SubjectRef: "user:u1", Purpose: "login", DeliveryMode: DeliveryModeWhatsApp, UserID: "u1"})
	if !IsPhoneOTPRateLimited(err) {
		t.Fatalf("err = %v, want phone_otp_rate_limited", err)
	}
	if IsCode(err, ErrCodeRateLimited) {
		t.Errorf("phone_otp_rate_limited must not also read as the generic rate_limited")
	}
}

// SPECX_1_whatsapp: the mode constant, the wire value, and the `delivered` echo.
func TestOTPIssue_WhatsAppMode(t *testing.T) {
	if DeliveryModeWhatsApp != "whatsapp" {
		t.Fatalf("DeliveryModeWhatsApp = %q", DeliveryModeWhatsApp)
	}
	var gotBody map[string]any
	srv := authTestServer(t, map[string]http.HandlerFunc{
		"/auth/otp/issue": func(w http.ResponseWriter, r *http.Request) {
			b, _ := io.ReadAll(r.Body)
			_ = json.Unmarshal(b, &gotBody)
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "otp-1", "delivered": "whatsapp", "expires_at": "2026-10-17T12:00:00Z", "purpose": "login", "subject_ref": "user:u1"})
		},
	})
	defer srv.Close()
	r, _ := NewRealm(Config{SessionStore: NewMemorySessionStore(), RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	resp, err := r.OTP.Issue(context.Background(), IssueRequest{SubjectRef: "user:u1", Purpose: "login", DeliveryMode: DeliveryModeWhatsApp, UserID: "u1"})
	if err != nil {
		t.Fatal(err)
	}
	if gotBody["delivery_mode"] != "whatsapp" || resp.Delivered != "whatsapp" || resp.Value != "" {
		t.Errorf("body=%v resp=%+v", gotBody, resp)
	}
}

// SPEC3_1_channels: delivery_unavailable is deliberately NOT registered. It stays
// on details.server_code and the issuer's new `channel` field lands in details.
func TestDeliveryUnavailable_StaysUnregisteredAndCarriesChannel(t *testing.T) {
	if isKnownCode("delivery_unavailable") {
		t.Fatal("delivery_unavailable must stay unregistered (registering a shipped code is breaking, SPEC §3.1)")
	}
	if isKnownCode("channel_unavailable") {
		t.Fatal("there is no channel_unavailable code (owner ruling 2026-10-17)")
	}
	srv := authTestServer(t, map[string]http.HandlerFunc{
		"/auth/otp/issue": func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(503)
			_, _ = w.Write([]byte(`{"error":{"code":"delivery_unavailable","message":"whatsapp is not available for this realm","channel":"whatsapp"}}`))
		},
	})
	defer srv.Close()
	r, _ := NewRealm(Config{SessionStore: NewMemorySessionStore(), RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	_, err := r.OTP.Issue(context.Background(), IssueRequest{SubjectRef: "user:u1", Purpose: "login", DeliveryMode: DeliveryModeWhatsApp, UserID: "u1"})
	var re *RealmError
	if !errors.As(err, &re) {
		t.Fatalf("err = %v", err)
	}
	if re.Details["server_code"] != "delivery_unavailable" || re.Details["channel"] != "whatsapp" || re.HTTPStatus != 503 {
		t.Errorf("code=%s status=%d details=%v", re.Code, re.HTTPStatus, re.Details)
	}
}

// SPEC4_1_4a: absent and [] must stay different, through a decode -> encode
// round trip (the reference BFF re-serialises this struct).
func TestIdentityProvidersResponse_PhoneChannels(t *testing.T) {
	roundTrip := func(in string) (IdentityProvidersResponse, map[string]any) {
		var resp IdentityProvidersResponse
		if err := json.Unmarshal([]byte(in), &resp); err != nil {
			t.Fatal(err)
		}
		out, err := json.Marshal(resp)
		if err != nil {
			t.Fatal(err)
		}
		var wire map[string]any
		_ = json.Unmarshal(out, &wire)
		return resp, wire
	}

	resp, wire := roundTrip(`{"providers":[],"credential_methods":["otp"],"phone_channels":["whatsapp","sms"]}`)
	if resp.PhoneChannels == nil || !reflect.DeepEqual(*resp.PhoneChannels, []string{"whatsapp", "sms"}) {
		t.Fatalf("decoded = %v", resp.PhoneChannels)
	}
	if !reflect.DeepEqual(wire["phone_channels"], []any{"whatsapp", "sms"}) {
		t.Errorf("list dropped or changed on re-serialisation: %v", wire["phone_channels"])
	}
	if !resp.OffersPhoneLogin() {
		t.Error("otp + non-empty phone_channels must offer phone login")
	}

	resp, wire = roundTrip(`{"providers":[],"credential_methods":["otp"],"phone_channels":[]}`)
	if resp.PhoneChannels == nil {
		t.Fatal("[] must decode to non-nil (present, empty)")
	}
	if v, ok := wire["phone_channels"]; !ok || !reflect.DeepEqual(v, []any{}) {
		t.Errorf("[] must survive as [] (omitempty would drop it): %v present=%v", v, ok)
	}
	if resp.OffersPhoneLogin() {
		t.Error("empty phone_channels must not offer phone login")
	}

	resp, wire = roundTrip(`{"providers":[],"credential_methods":["otp"]}`)
	if resp.PhoneChannels != nil {
		t.Error("absent must decode to nil")
	}
	if _, ok := wire["phone_channels"]; ok {
		t.Error("absent must stay absent on re-serialisation")
	}
	if resp.OffersPhoneLogin() {
		t.Error("absent phone_channels must not offer phone login (older issuer)")
	}

	resp, _ = roundTrip(`{"providers":[],"credential_methods":["password"],"phone_channels":["sms"]}`)
	if resp.OffersPhoneLogin() {
		t.Error("phone_channels without otp in credential_methods must not offer phone login")
	}
}

// SPEC6_5_phone_otp: the typed READ view over the loose config map.
func TestConfigValues_PhoneOTP(t *testing.T) {
	var resp ConfigResponse
	in := `{"id":"r","config":{"idle_ttl_seconds":0,"phone_otp":{"max_per_window":5,"window_seconds":900}}}`
	if err := json.Unmarshal([]byte(in), &resp); err != nil {
		t.Fatal(err)
	}
	p := resp.Config.PhoneOTP()
	if p == nil || p.MaxPerWindow != 5 || p.WindowSeconds != 900 {
		t.Fatalf("PhoneOTP() = %+v", p)
	}
	if (ConfigValues{}).PhoneOTP() != nil {
		t.Error("absent key must be nil (the issuer did not say), not zeros")
	}
	if (ConfigValues{"phone_otp": "garbage"}).PhoneOTP() != nil {
		t.Error("a malformed value must be nil, not a panic or zeros")
	}
}

package realmid

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"testing"
)

// R7+R9 SDK surface (issuer spec 0.62.0, ADR-117 / ADR-116 third amendment).

func newR9Realm(t *testing.T, handlers map[string]http.HandlerFunc) *Realm {
	t.Helper()
	srv := meServer(t, handlers)
	t.Cleanup(srv.Close)
	r, err := NewRealm(Config{SessionStore: NewMemorySessionStore(), RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func r9ReadJSON(t *testing.T, r *http.Request) map[string]any {
	t.Helper()
	var m map[string]any
	buf, _ := io.ReadAll(r.Body)
	_ = json.Unmarshal(buf, &m)
	return m
}

func TestR9_ConfigUniqueKindsAndReport(t *testing.T) {
	realm := newR9Realm(t, map[string]http.HandlerFunc{
		"/platforms/" + testRealmID + "/config": func(w http.ResponseWriter, r *http.Request) {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id":     testRealmID,
				"config": map[string]any{"contacts": map[string]any{"unique_kinds": []string{"email"}}},
				"unique_kinds_report": map[string]any{
					"email": map[string]any{"values_on_multiple_memberships": 3},
				},
			})
		},
	})
	cfg, err := realm.Config.Get(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	kinds, ok := cfg.Config.UniqueKinds()
	if !ok || len(kinds) != 1 || kinds[0] != "email" {
		t.Errorf("UniqueKinds=%v ok=%v", kinds, ok)
	}
	if cfg.UniqueKindsReport["email"].ValuesOnMultipleMemberships != 3 {
		t.Errorf("report=%+v", cfg.UniqueKindsReport)
	}
	if _, present := cfg.UniqueKindsReport["phone"]; present {
		t.Errorf("absent kind must stay absent, got %+v", cfg.UniqueKindsReport)
	}
	// An explicit [] is a legal, different answer from "not sent".
	empty := ConfigValues{"contacts": map[string]any{"unique_kinds": []any{}}}
	if k, ok := empty.UniqueKinds(); !ok || len(k) != 0 {
		t.Errorf("explicit [] => %v ok=%v", k, ok)
	}
	if _, ok := (ConfigValues{}).UniqueKinds(); ok {
		t.Errorf("missing group must report ok=false")
	}
}

func TestR9_ConfigUpdateConfirmLockoutIsAQueryParameter(t *testing.T) {
	var gotQuery, gotConfirmHdr string
	var gotBody map[string]any
	realm := newR9Realm(t, map[string]http.HandlerFunc{
		"/platforms/" + testRealmID + "/config": func(w http.ResponseWriter, r *http.Request) {
			gotQuery = r.URL.RawQuery
			gotConfirmHdr = r.Header.Get("X-Confirm-Lockout")
			gotBody = r9ReadJSON(t, r)
			w.WriteHeader(200)
			_, _ = w.Write([]byte(`{}`))
		},
	})
	patch := ConfigPatch{"contacts": map[string]any{"unique_kinds": []string{"phone"}}}
	if err := realm.Config.UpdateWithOptions(context.Background(), patch, ConfigUpdateOptions{ConfirmLockout: true}); err != nil {
		t.Fatal(err)
	}
	if gotQuery != "confirm_lockout=true" || gotConfirmHdr != "" {
		t.Errorf("query=%q header=%q", gotQuery, gotConfirmHdr)
	}
	if gotBody["contacts"] == nil {
		t.Errorf("body=%v", gotBody)
	}
	if err := realm.Config.UpdateWithOptions(context.Background(), patch, ConfigUpdateOptions{}); err != nil {
		t.Fatal(err)
	}
	if gotQuery != "" {
		t.Errorf("no confirm must send no query, got %q", gotQuery)
	}
}

func TestR9_ContactProofSendAndConfirm(t *testing.T) {
	var sendBody, confirmBody map[string]any
	var sendUT string
	realm := newR9Realm(t, map[string]http.HandlerFunc{
		"/me/contacts/c-1/proof": func(w http.ResponseWriter, r *http.Request) {
			sendUT = r.Header.Get("X-User-Token")
			sendBody = r9ReadJSON(t, r)
			_ = json.NewEncoder(w).Encode(map[string]any{"delivered": "sms"})
		},
		"/me/contacts/c-1/proof/confirm": func(w http.ResponseWriter, r *http.Request) {
			confirmBody = r9ReadJSON(t, r)
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "c-1", "kind": "phone", "value": "+15550100", "verified": true, "verified_at": "2026-10-19T00:00:00Z"})
		},
	})
	sent, err := realm.Me.SendContactProof(context.Background(), ContactProofSendRequest{MeAuth: MeAuth{UserToken: "ut"}, ContactID: "c-1", DeliveryMode: "sms"})
	if err != nil {
		t.Fatal(err)
	}
	if sent.Delivered != "sms" || sendBody["delivery_mode"] != "sms" || sendUT != "ut" {
		t.Errorf("sent=%+v body=%v ut=%q", sent, sendBody, sendUT)
	}
	got, err := realm.Me.ConfirmContactProof(context.Background(), ContactProofConfirmRequest{MeAuth: MeAuth{UserBearer: "jwt"}, ContactID: "c-1", Code: "123456"})
	if err != nil {
		t.Fatal(err)
	}
	if confirmBody["code"] != "123456" || !got.Verified || got.Kind != "phone" || got.VerifiedAt == "" {
		t.Errorf("got=%+v body=%v", got, confirmBody)
	}
}

func TestR9_InvitationInspectAndAccept(t *testing.T) {
	var inspBody, accBody map[string]any
	realm := newR9Realm(t, map[string]http.HandlerFunc{
		"/auth/invitations/inspect": func(w http.ResponseWriter, r *http.Request) {
			inspBody = r9ReadJSON(t, r)
			_ = json.NewEncoder(w).Encode(map[string]any{"tenant_id": "t-1", "tenant_display_name": "Acme", "expires_at": "2026-10-26T00:00:00Z"})
		},
		"/auth/invitations/accept": func(w http.ResponseWriter, r *http.Request) {
			accBody = r9ReadJSON(t, r)
			// The MFA-challenge arm of the password-grant result type.
			_ = json.NewEncoder(w).Encode(map[string]any{"status": "mfa_required", "mfa_challenge_token": "mct", "methods": []string{"totp"}})
		},
	})
	in, err := realm.Auth.InspectInvitation(context.Background(), "tok")
	if err != nil {
		t.Fatal(err)
	}
	if inspBody["token"] != "tok" || in.TenantID != "t-1" || in.TenantDisplayName != "Acme" || in.ExpiresAt == "" {
		t.Errorf("inspect=%+v body=%v", in, inspBody)
	}
	s, err := realm.Auth.AcceptInvitation(context.Background(), AcceptInvitationRequest{Token: "tok", Username: "alice", Password: "correct horse battery"})
	if err != nil {
		t.Fatal(err)
	}
	if accBody["token"] != "tok" || accBody["username"] != "alice" || accBody["password"] != "correct horse battery" {
		t.Errorf("accept body=%v", accBody)
	}
	// Same type as PasswordLogin: the *Session.
	var _ *Session = s
}

func TestR9_InvitationResend(t *testing.T) {
	var method string
	realm := newR9Realm(t, map[string]http.HandlerFunc{
		"/tenants/t-1/invitations/inv-9/resend": func(w http.ResponseWriter, r *http.Request) {
			method = r.Method
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "inv-9", "identifier": "a@b.c", "status": "pending"})
		},
	})
	inv, err := realm.Tenants.Invitations.Resend(context.Background(), "t-1", "inv-9")
	if err != nil {
		t.Fatal(err)
	}
	if method != "POST" || inv.ID != "inv-9" || inv.Status != "pending" {
		t.Errorf("method=%s inv=%+v", method, inv)
	}
}

// The §3.2 codes, registered: the wire code must survive into RealmError.Code.
func TestR9_NewCodesAreRegistered(t *testing.T) {
	codes := map[ErrorCode]string{
		ErrCodeUniqueKindsRequiresPassword:  "unique_kinds_requires_password",
		ErrCodePasswordLoginRequired:        "password_login_required",
		ErrCodeUniqueKindLockout:            "unique_kind_lockout",
		ErrCodeUniqueKindLockoutCheckFailed: "unique_kind_lockout_check_failed",
		ErrCodeUniqueKindDuplicates:         "unique_kind_duplicates",
		ErrCodeEmailKeyedSigninEnabled:      "email_keyed_signin_enabled",
		ErrCodeRequireVerifiedEmailConflict: "require_verified_email_conflict",
		ErrCodeIdPRequiresIdentifyingEmail:  "idp_requires_identifying_email",
		ErrCodeIdPRequiresIdentifyingPhone:  "idp_requires_identifying_phone",
		ErrCodeDomainSSORequiresUniqueEmail: "domain_sso_requires_unique_email",
		ErrCodeInviteContactNotIdentifying:  "invite_contact_not_identifying",
		ErrCodeRecipientEmailNotIdentifying: "recipient_email_not_identifying",
		ErrCodeInvalidInvitationToken:       "invalid_invitation_token",
		ErrCodeContactNotFound:              "contact_not_found",
		ErrCodeContactAlreadyVerified:       "contact_already_verified",
		ErrCodeContactChanged:               "contact_changed",
		ErrCodeResetEmailNotIdentifying:     "reset_email_not_identifying",
	}
	for c, wire := range codes {
		if string(c) != wire {
			t.Errorf("const %q != wire %q", c, wire)
		}
		if !isKnownCode(wire) {
			t.Errorf("%s not registered", wire)
		}
	}
}

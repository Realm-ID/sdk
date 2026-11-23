package realmid

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
)

func TestContactVerificationsList_NamesTheAccountAndAddress(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/tenants/t1/contact-verifications", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"items": []any{
			map[string]any{
				"id": "cv1", "contact_id": "c1", "user_id": "u1", "method": "google",
				"provider_uid": "p1", "state": "pending", "created_at": 1,
				"contact_kind": "email", "contact_value_masked": "j***@example.com",
				"user_display_name": "Jo", "user_email_masked": "j***@example.com",
				"asserted_identity": map[string]any{"email_masked": "k***@example.com", "phone_masked": "+44*******123", "display_name": "Kay"},
			},
			map[string]any{"id": "cv2", "contact_id": "c2", "user_id": "u2", "method": "google", "provider_uid": "p2", "state": "pending", "created_at": 2},
		}, "next_cursor": ""})
	})
	r := joinedViaRealm(t, mux)
	pg, err := r.Tenants.ContactVerifications.List(context.Background(), "t1", nil).Page(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	got := pg.Items[0]
	if got.ContactKind != "email" || got.ContactValueMasked != "j***@example.com" ||
		got.UserDisplayName != "Jo" || got.UserEmailMasked != "j***@example.com" {
		t.Errorf("populated row decoded as %+v", got)
	}
	if got.AssertedIdentity == nil || got.AssertedIdentity.EmailMasked != "k***@example.com" ||
		got.AssertedIdentity.PhoneMasked != "+44*******123" || got.AssertedIdentity.DisplayName != "Kay" {
		t.Errorf("asserted_identity decoded as %+v", got.AssertedIdentity)
	}
	bare := pg.Items[1]
	if bare.ContactKind != "" || bare.ContactValueMasked != "" || bare.AssertedIdentity != nil {
		t.Errorf("row without the fields must decode to zero values: %+v", bare)
	}
}

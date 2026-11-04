package realmid

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"testing"
)

// SPEC §X.4a (issuer ADR-123): DeliveryModeEmail with an email address as the Identifier is sent
// as delivery_mode "email". Go's request carries DeliveryMode as a string, so this PINS the
// pass-through (it was green on arrival; there is no Go type to widen).
func TestAuth_SendLoginCode_EmailMode(t *testing.T) {
	var gotBody map[string]any
	srv := authTestServer(t, map[string]http.HandlerFunc{
		"/auth/otp/send-login": func(w http.ResponseWriter, r *http.Request) {
			buf, _ := io.ReadAll(r.Body)
			_ = json.Unmarshal(buf, &gotBody)
			w.WriteHeader(http.StatusAccepted)
			_, _ = w.Write([]byte(`{"sent_if_registered":true}`))
		},
	})
	defer srv.Close()
	r, _ := NewRealm(Config{SessionStore: NewMemorySessionStore(), RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	out, err := r.Auth.SendLoginCode(context.Background(), SendLoginCodeRequest{
		Identifier: "ana@acme.example", DeliveryMode: DeliveryModeEmail,
	})
	if err != nil || out == nil || !out.SentIfRegistered {
		t.Fatalf("SendLoginCode = %+v, %v", out, err)
	}
	if gotBody["identifier"] != "ana@acme.example" || gotBody["delivery_mode"] != "email" {
		t.Errorf("body = %v", gotBody)
	}
}

package realmid

import (
	"encoding/json"
	"testing"
)

// TestIdentityProvidersResponse_CredentialMethodsSurviveRoundTrip pins the
// exact defect that shipped in go 0.53.0.
//
// The reference BFF does not read discovery — it DECODES the issuer's response
// into IdentityProvidersResponse and re-serialises the struct to the browser.
// So any field this type omits is deleted from what the login screen receives,
// silently, with no error at any layer. `credential_methods` was omitted, and
// the result was that ADR-103/104 credential sign-in could not be rendered by
// any BFF-fronted console even though the issuer advertised it correctly.
//
// A decode-only assertion is NOT enough here and is the reason this went
// unnoticed: reading the field back off a struct you just populated passes
// whether or not the field is carried onward. The round trip is the behaviour
// under test, so this encodes the struct again and asserts the wire key
// survives.
func TestIdentityProvidersResponse_CredentialMethodsSurviveRoundTrip(t *testing.T) {
	const upstream = `{"providers":[{"type":"google"}],"credential_methods":["password","otp"]}`

	var resp IdentityProvidersResponse
	if err := json.Unmarshal([]byte(upstream), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got := len(resp.CredentialMethods); got != 2 {
		t.Fatalf("decoded CredentialMethods = %d entries, want 2 (%v)", got, resp.CredentialMethods)
	}

	out, err := json.Marshal(resp)
	if err != nil {
		t.Fatalf("re-encode: %v", err)
	}
	var wire map[string]any
	if err := json.Unmarshal(out, &wire); err != nil {
		t.Fatalf("decode re-encoded: %v", err)
	}
	methods, ok := wire["credential_methods"]
	if !ok {
		t.Fatalf("credential_methods was DROPPED on re-serialisation: %s", out)
	}
	list, ok := methods.([]any)
	if !ok || len(list) != 2 || list[0] != "password" || list[1] != "otp" {
		t.Fatalf("credential_methods round-tripped as %#v, want [password otp]", methods)
	}
}

// TestIdentityProvidersResponse_AbsentIsNotEmpty guards the other half of the
// contract. An older issuer omits the field entirely, and a client must be able
// to tell "the server did not say" from "this realm offers nothing" — so the
// key must NOT appear on the way out when it did not appear on the way in.
func TestIdentityProvidersResponse_AbsentIsNotEmpty(t *testing.T) {
	var resp IdentityProvidersResponse
	if err := json.Unmarshal([]byte(`{"providers":[]}`), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.CredentialMethods != nil {
		t.Fatalf("absent field decoded to %#v, want nil", resp.CredentialMethods)
	}

	out, err := json.Marshal(resp)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	var wire map[string]any
	if err := json.Unmarshal(out, &wire); err != nil {
		t.Fatalf("decode re-encoded: %v", err)
	}
	if _, present := wire["credential_methods"]; present {
		t.Fatalf("absent credential_methods was re-emitted as a key: %s", out)
	}
}

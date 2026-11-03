package realmid

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

// SPEC §1 / §5 / §14.4: issuerUrl is the host the issuer stamps into `iss`
// (default baseUrl). Only the iss checks read it; every fetch stays on baseUrl.

const publicIssuer = "https://public.example"

func issuerURLRealm(t *testing.T, base, issuerURL string) *Realm {
	t.Helper()
	r, err := NewRealm(Config{SessionStore: NewMemorySessionStore(),
		RealmID: testRealmID, APIKey: "rk_live_test", BaseURL: base, IssuerURL: issuerURL})
	if err != nil {
		t.Fatalf("NewRealm: %v", err)
	}
	return r
}

// countingServer is fakeServer plus a counter of JWKS requests, so a test can
// assert the fetch REALLY reached this (internal) server.
func countingServer(t *testing.T, pub jwk) (*httptest.Server, *int32) {
	t.Helper()
	var jwksHits int32
	inner := fakeServer(t, map[string][]jwk{testRealmID: {pub}}, testAud)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.URL.Path == "/"+testRealmID+"/.well-known/jwks.json" {
			atomic.AddInt32(&jwksHits, 1)
			_ = json.NewEncoder(w).Encode(jwksDoc{Keys: []jwk{pub}})
			return
		}
		inner.Config.Handler.ServeHTTP(w, req)
	}))
	t.Cleanup(func() { srv.Close(); inner.Close() })
	return srv, &jwksHits
}

func TestIssuerURL_VerifiesAgainstPublicIssuerWhileFetchingInternal(t *testing.T) {
	sign, pub := mintKey(t, "kid-1")
	srv, hits := countingServer(t, pub)
	r := issuerURLRealm(t, srv.URL, publicIssuer)
	tok := sign(baseClaims(publicIssuer))
	if _, err := r.Verify(context.Background(), tok, nil); err != nil {
		t.Fatalf("verify with issuerUrl set: %v", err)
	}
	// Positive control: the JWKS fetch went to baseUrl (the internal server).
	if got := atomic.LoadInt32(hits); got != 1 {
		t.Fatalf("internal server saw %d JWKS requests, want 1", got)
	}
}

func TestIssuerURL_UnsetStillChecksBaseURL(t *testing.T) {
	sign, pub := mintKey(t, "kid-1")
	srv, hits := countingServer(t, pub)
	r := issuerURLRealm(t, srv.URL, "")
	tok := sign(baseClaims(publicIssuer))
	_, err := r.Verify(context.Background(), tok, nil)
	if !IsCode(err, ErrCodeWrongIssuer) {
		t.Fatalf("want wrong_issuer with IssuerURL unset, got %v", err)
	}
	_ = hits
}

func TestIssuerURL_TrailingSlashTrimmed(t *testing.T) {
	sign, pub := mintKey(t, "kid-1")
	srv, _ := countingServer(t, pub)
	r := issuerURLRealm(t, srv.URL, publicIssuer+"/")
	if _, err := r.Verify(context.Background(), sign(baseClaims(publicIssuer)), nil); err != nil {
		t.Fatalf("trailing slash on IssuerURL: %v", err)
	}
}

func TestIssuerURL_BlankFallsBackToBaseURL(t *testing.T) {
	for _, blank := range []string{"", "   ", "\t\n"} {
		sign, pub := mintKey(t, "kid-1")
		srv, _ := countingServer(t, pub)
		r := issuerURLRealm(t, srv.URL, blank)
		if _, err := r.Verify(context.Background(), sign(baseClaims(srv.URL)), nil); err != nil {
			t.Fatalf("blank %q must fall back to baseUrl: %v", blank, err)
		}
		if _, err := r.Verify(context.Background(), sign(baseClaims(publicIssuer)), nil); !IsCode(err, ErrCodeWrongIssuer) {
			t.Fatalf("blank %q: public iss want wrong_issuer, got %v", blank, err)
		}
	}
}

func TestIssuerURL_WrongIssuerNamesReceivedIssOnly(t *testing.T) {
	sign, pub := mintKey(t, "kid-1")
	srv, _ := countingServer(t, pub)
	r := issuerURLRealm(t, srv.URL, publicIssuer)
	_, err := r.Verify(context.Background(), sign(baseClaims("https://evil.example")), nil)
	if !IsCode(err, ErrCodeWrongIssuer) {
		t.Fatalf("want wrong_issuer, got %v", err)
	}
	if msg := err.Error(); !containsStr(msg, "https://evil.example/"+testRealmID) || containsStr(msg, publicIssuer) {
		t.Fatalf("message must name the received iss only: %q", msg)
	}
}

// Side finding: SPEC §5 says iss starts with `${issuerUrl}/${realmId}`; the
// verifier used to check only `${baseUrl}/`.
func TestIssuerURL_OtherRealmIssRefused(t *testing.T) {
	sign, pub := mintKey(t, "kid-1")
	srv, _ := countingServer(t, pub)
	r := issuerURLRealm(t, srv.URL, publicIssuer)
	c := baseClaims(publicIssuer)
	c["iss"] = publicIssuer + "/01HOTHERREALM"
	_, err := r.Verify(context.Background(), sign(c), nil)
	if !IsCode(err, ErrCodeWrongIssuer) {
		t.Fatalf("iss naming another realm: want wrong_issuer, got %v", err)
	}
}

func TestIssuerURL_CoSignerExpectedIssuerUsesIssuerURL(t *testing.T) {
	r := issuerURLRealm(t, "http://internal:8080/", publicIssuer+"/")
	if got, want := r.expectedIssuer(), publicIssuer+"/"+testRealmID; got != want {
		t.Fatalf("expectedIssuer = %q, want %q", got, want)
	}
	r = issuerURLRealm(t, "http://internal:8080/", "")
	if got, want := r.expectedIssuer(), "http://internal:8080/"+testRealmID; got != want {
		t.Fatalf("default expectedIssuer = %q, want %q", got, want)
	}
}

func containsStr(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}

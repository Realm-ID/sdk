package realmid

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"testing"
	"time"
)

func makeJWT(t *testing.T, claims map[string]any) string {
	t.Helper()
	hdr := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"RS256","typ":"JWT"}`))
	body, _ := json.Marshal(claims)
	pl := base64.RawURLEncoding.EncodeToString(body)
	return hdr + "." + pl + ".sig"
}

func TestTokensClient_MarkAndIsRevoked(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	tc := newTokensClient(func() time.Time { return now })
	tok := makeJWT(t, map[string]any{"jti": "abc", "exp": now.Add(15 * time.Minute).Unix()})
	if tc.IsRevoked(tok) {
		t.Fatal("fresh cache should not flag")
	}
	tc.MarkRevoked(tok)
	if !tc.IsRevoked(tok) {
		t.Fatal("expected revoked")
	}
}

func TestTokensClient_TTLExpiry(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	clock := now
	tc := newTokensClient(func() time.Time { return clock })
	tok := makeJWT(t, map[string]any{"jti": "abc", "exp": now.Add(60 * time.Second).Unix()})
	tc.MarkRevoked(tok)
	if tc.Len() != 1 {
		t.Fatalf("len=%d", tc.Len())
	}
	clock = now.Add(2 * time.Minute)
	if tc.IsRevoked(tok) {
		t.Fatal("should be expired")
	}
	if tc.Len() != 0 {
		t.Fatalf("expected lazy GC; len=%d", tc.Len())
	}
}

func TestTokensClient_MarkRevokedNoop(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	tc := newTokensClient(func() time.Time { return now })

	// missing jti
	tc.MarkRevoked(makeJWT(t, map[string]any{"exp": now.Add(15 * time.Minute).Unix()}))
	// missing exp
	tc.MarkRevoked(makeJWT(t, map[string]any{"jti": "x"}))
	// past exp
	tc.MarkRevoked(makeJWT(t, map[string]any{"jti": "y", "exp": now.Add(-time.Minute).Unix()}))
	if tc.Len() != 0 {
		t.Fatalf("expected 0 entries, got %d", tc.Len())
	}
}

func TestTokensClient_GateRequest(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	tc := newTokensClient(func() time.Time { return now })
	tok := makeJWT(t, map[string]any{"jti": "abc", "exp": now.Add(15 * time.Minute).Unix()})

	if err := tc.GateRequest(tok); err != nil {
		t.Fatalf("expected nil before mark, got %v", err)
	}
	tc.MarkRevoked(tok)
	err := tc.GateRequest(tok)
	if err == nil {
		t.Fatal("expected error")
	}
	if !errors.Is(err, ErrTokenRevoked) {
		t.Fatalf("want ErrTokenRevoked, got %v", err)
	}
	var re *RealmError
	if !errors.As(err, &re) || re.Code != ErrCodeUnauthorized {
		t.Fatalf("expected RealmError(unauthorized), got %v", err)
	}
	if rev, _ := re.Details["revoked"].(bool); !rev {
		t.Fatalf("expected details.revoked=true; got %v", re.Details)
	}
}

func TestTokensClient_RevokeOnLogout_FailureStillCaches(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	tc := newTokensClient(func() time.Time { return now })
	tok := makeJWT(t, map[string]any{"jti": "abc", "exp": now.Add(15 * time.Minute).Unix()})

	netErr := errors.New("RI unreachable")
	failingLogout := func(_ context.Context, _ *LogoutRequest) error { return netErr }
	wrapped := tc.RevokeOnLogout(failingLogout)
	if err := wrapped(context.Background(), tok, nil); !errors.Is(err, netErr) {
		t.Fatalf("expected wrapped err, got %v", err)
	}
	if !tc.IsRevoked(tok) {
		t.Fatal("expected jti cached after failed logout (fail-closed)")
	}
}

func TestTokensClient_RevokeOnLogout_Success(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	tc := newTokensClient(func() time.Time { return now })
	tok := makeJWT(t, map[string]any{"jti": "abc", "exp": now.Add(15 * time.Minute).Unix()})

	calls := 0
	okLogout := func(_ context.Context, _ *LogoutRequest) error { calls++; return nil }
	wrapped := tc.RevokeOnLogout(okLogout)
	if err := wrapped(context.Background(), tok, nil); err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if calls != 1 {
		t.Fatalf("logout invoked %d times", calls)
	}
	if !tc.IsRevoked(tok) {
		t.Fatal("expected jti cached after success")
	}
}

func TestTokensClient_NoUnboundedGrowth(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	tc := newTokensClient(func() time.Time { return now })
	tok := makeJWT(t, map[string]any{"jti": "abc", "exp": now.Add(15 * time.Minute).Unix()})
	for i := 0; i < 100; i++ {
		tc.MarkRevoked(tok)
	}
	if tc.Len() != 1 {
		t.Fatalf("expected 1 entry, got %d", tc.Len())
	}
}

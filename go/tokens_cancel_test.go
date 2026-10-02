package realmid

// SPEC §6.7.2 "Cancellation is not a store error": a client hang-up must not
// turn the revocation check into a fail-open, nor drop a revoke write.

import (
	"context"
	"testing"
	"time"
)

// ctxAwareStore honours ctx cancellation like a real network store.
type ctxAwareStore struct{ *MemorySessionStore }

func (s ctxAwareStore) SessionStates(ctx context.Context, keys []string) ([]SessionState, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return s.MemorySessionStore.SessionStates(ctx, keys)
}

func (s ctxAwareStore) RevokeSession(ctx context.Context, key string, until time.Time) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	return s.MemorySessionStore.RevokeSession(ctx, key, until)
}

func (s ctxAwareStore) RaiseNotBefore(ctx context.Context, key string, nb, until time.Time) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	return s.MemorySessionStore.RaiseNotBefore(ctx, key, nb, until)
}

func TestSPEC6_7_2_CancelledCtxDoesNotFailOpen(t *testing.T) {
	tc := newTokensClient(nil, ctxAwareStore{NewMemorySessionStore()}, nil, nil)
	tok := tokOf(t, "sid-1", "u1", time.Now())
	tc.RevokeSession(context.Background(), "sid-1")

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if !tc.IsRevoked(ctx, tok) {
		t.Fatal("a cancelled request ctx made IsRevoked fail open on a revoked session")
	}
	if err := tc.GateRequest(ctx, tok); err == nil {
		t.Fatal("GateRequest let a revoked bearer through on a cancelled ctx")
	}
}

func TestSPEC6_7_2_CancelledCtxStillRecordsRevokeAndRefresh(t *testing.T) {
	tc := newTokensClient(nil, ctxAwareStore{NewMemorySessionStore()}, nil, nil)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	tc.RevokeSession(ctx, "sid-2")
	if !tc.IsRevoked(context.Background(), tokOf(t, "sid-2", "u1", time.Now())) {
		t.Fatal("RevokeSession on a cancelled ctx dropped the write")
	}

	newTok := tokOf(t, "sid-3", "u1", time.Now())
	oldTok := tokOf(t, "sid-3", "u1", time.Now().Add(-time.Hour))
	tc.RecordRefresh(ctx, newTok)
	if !tc.IsRevoked(context.Background(), oldTok) {
		t.Fatal("RecordRefresh on a cancelled ctx dropped the not-before mark")
	}
}

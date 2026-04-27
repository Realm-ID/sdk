package realmid

import (
	"context"
	"testing"
	"time"
)

func TestMemRevocationCache(t *testing.T) {
	t.Run("empty_cache_reports_not_revoked", func(t *testing.T) {
		c := NewMemRevocationCache(nil)
		got, err := c.IsRevoked(context.Background(), "any")
		if err != nil || got {
			t.Fatalf("want (false,nil), got (%v,%v)", got, err)
		}
	})

	t.Run("revoked_jti_reports_true_within_ttl", func(t *testing.T) {
		now := time.Date(2026, 4, 27, 12, 0, 0, 0, time.UTC)
		c := NewMemRevocationCache(func() time.Time { return now })
		_ = c.Revoke(context.Background(), "jti-1", now.Add(15*time.Minute))
		got, _ := c.IsRevoked(context.Background(), "jti-1")
		if !got {
			t.Fatalf("want revoked")
		}
	})

	t.Run("expired_entry_evicts_lazily", func(t *testing.T) {
		now := time.Date(2026, 4, 27, 12, 0, 0, 0, time.UTC)
		clock := now
		c := NewMemRevocationCache(func() time.Time { return clock })
		_ = c.Revoke(context.Background(), "jti-1", now.Add(5*time.Minute))
		// Advance past expiry.
		clock = now.Add(10 * time.Minute)
		got, _ := c.IsRevoked(context.Background(), "jti-1")
		if got {
			t.Fatalf("want not revoked after ttl")
		}
		if c.Len() != 0 {
			t.Fatalf("want eviction, len=%d", c.Len())
		}
	})

	t.Run("empty_jti_is_noop", func(t *testing.T) {
		c := NewMemRevocationCache(nil)
		_ = c.Revoke(context.Background(), "", time.Now())
		got, _ := c.IsRevoked(context.Background(), "")
		if got {
			t.Fatalf("empty jti should never be revoked")
		}
		if c.Len() != 0 {
			t.Fatalf("empty revoke should not add entry")
		}
	})
}

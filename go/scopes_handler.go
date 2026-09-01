package realmid

import (
	ctxpkg "context"
	"errors"
	"fmt"
	"time"
)

// scopes_handler.go — ADR-097 granted authority, resolved per mint.
//
// This is the `scope` twin of ProductRolesHandler, and the two are deliberately
// shaped identically: one realm-level handler, run at every mint, its result
// carried onto the token. They answer different questions — `scope` is GRANTED
// AUTHORITY and `product_roles` is a NAME — but they are resolved by the same
// mechanism because they have the same freshness requirement.
//
// # Why a handler at all, rather than a field on the request
//
// A per-call field only reaches calls a partner writes BY HAND. In a BFF
// deployment humans mint through the middleware, which builds the request
// itself and never exposes it — so a per-call field is, for the lane that
// carries every human session, unreachable. That is not hypothetical: a partner
// hit it, and the integration guide had to be corrected for pointing at the
// per-call field instead of the realm-level handler.

// ScopesHandler resolves the partner's own ADR-097 scope strings for a
// principal in one org.
//
// ⚠️ SIDE-EFFECT FREEDOM IS A CONTRACT, NOT A SUGGESTION. The SDK calls this an
// UNSPECIFIED NUMBER OF TIMES per mint — it retries on error — so the handler
// MUST NOT write, bill, audit, or emit. A partner who logs "scopes resolved"
// inside it will see triple entries and be right to call it a bug. Retrying is
// only legal because this is specified as a pure read.
//
// It runs on EVERY mint, refresh included, and nothing caches. That is the
// whole point: the issuer NEVER stores `scope` on a session — deliberately, so
// it cannot go stale — so an unrequested claim is an ABSENT one, and absent
// reads as "no granted authority" in every SDK gate. A session whose scopes are
// resolved only at login therefore loses its authority at the first refresh.
//
// Returning an empty slice or nil mints NO claim, not an empty one. Absent and
// empty must mean the same thing here: every token issued before ADR-097 has no
// claim at all, so a reader handles absence regardless.
//
// ⚠️ That rule is NOT shared with RolePermissions, where an empty non-nil list
// is a real instruction ("this role confers nothing here") that the issuer
// answers with a 403. The asymmetry is deliberate; do not harmonise it.
type ScopesHandler func(ctx ctxpkg.Context, tenantID, userID string) ([]string, error)

// ScopesError reports that YOUR handler failed and the SDK therefore refused to
// mint.
//
// ⚠️ Deliberately NOT a *RealmError, for the reason ProductRolesError gives:
// "your scope handler failed 3 times" and "RealmID refused your mint" are
// different incidents and must not look alike in your logs — one is your
// database, the other is ours.
//
// The refusal is the point, and it matters more here than it does for
// product_roles. Minting anyway would put NO granted authority on the token,
// which every gate reads as "denied" — so a transient blip in your role store
// would become an authorization outage that our logs record as a clean 200.
type ScopesError struct {
	TenantID string
	UserID   string
	Attempts int
	Err      error
}

func (e *ScopesError) Error() string {
	return fmt.Sprintf("realmid: scopes handler failed after %d attempts for tenant %s: %v",
		e.Attempts, e.TenantID, e.Err)
}

func (e *ScopesError) Unwrap() error { return e.Err }

// resolveScopes runs the configured handler with the same retry policy as
// resolveProductRoles: three attempts, ~50ms then ~150ms of backoff, abandoning
// immediately if the caller's context is already done.
//
// Returns (nil, nil) when no handler is configured — the claim is omitted and
// that is NOT an error. Making it mandatory would break every existing
// integration on upgrade for a feature they did not ask for.
//
// The policy is shared with product_roles ON PURPOSE. Two retry budgets on one
// mint path would compound into a latency ceiling nobody chose: the two
// handlers run in sequence, so the worst case is the sum, and keeping them
// identical is what makes that sum predictable.
func (r *Realm) resolveScopes(ctx ctxpkg.Context, tenantID, userID string) ([]string, error) {
	h := r.cfg.Scopes
	if h == nil {
		return nil, nil
	}
	var last error
	for attempt := 0; attempt < productRolesAttempts; attempt++ {
		if attempt > 0 {
			select {
			case <-ctx.Done():
				return nil, &ScopesError{
					TenantID: tenantID, UserID: userID,
					Attempts: attempt, Err: errors.Join(last, ctx.Err()),
				}
			case <-time.After(productRolesBackoff[attempt-1]):
			}
		}
		scopes, err := h(ctx, tenantID, userID)
		if err == nil {
			return scopes, nil
		}
		last = err
		if ctx.Err() != nil {
			break
		}
	}
	return nil, &ScopesError{
		TenantID: tenantID, UserID: userID,
		Attempts: productRolesAttempts, Err: last,
	}
}

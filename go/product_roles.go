package realmid

import (
	ctxpkg "context"
	"errors"
	"fmt"
	"time"
)

// product_roles.go — ADR-102 D3/D10/D11: the PARTNER's role name on the token,
// and the mint that carries it.
//
// `scope` (ADR-097) carries granted AUTHORITY; `product_roles` carries the NAME
// of the role the bearer holds in YOUR system, for display ("Signed in as:
// Dispatch"), routing, report defaults and your own audit trail.
//
// ⚠️ Do NOT branch AUTHORIZATION on it. A name is a label, a scope is a grant.
// Keying authorization off the name re-creates exactly the coupling ADR-101
// spent four migrations removing — add a role and every service needs editing.
// Both claims ride the same token and answer different questions.

// ProductRolesHandler resolves the partner's own role names for a principal in
// one org (ADR-102 D3).
//
// ⚠️ SIDE-EFFECT FREEDOM IS A CONTRACT, NOT A SUGGESTION. The SDK calls this an
// UNSPECIFIED NUMBER OF TIMES per mint — it retries on error (D11) — so the
// handler MUST NOT write, bill, audit, or emit. A partner who logs "role
// resolved" inside it will see triple entries and be right to call it a bug.
// Retrying is only legal because this is specified as a pure read.
//
// It runs on EVERY mint, refresh included, and nothing caches. That freshness is
// the entire advantage this claim has over `custom_claims`, which snapshots a
// value onto a long-lived session.
//
// Returning an empty slice or nil mints NO claim, not `[]`. Absent and empty
// must mean the same thing: every token issued before ADR-102 has no claim at
// all, so a reader has to handle absence regardless.
type ProductRolesHandler func(ctx ctxpkg.Context, tenantID, userID string) ([]string, error)

// ProductRolesError reports that YOUR handler failed and the SDK therefore
// refused to mint (ADR-102 D11 rule 3).
//
// ⚠️ It is deliberately NOT a *RealmError. "Your role handler failed 3 times"
// and "RealmID refused your mint" are different incidents and must not look
// alike in your logs — one is your database, the other is ours.
//
// The refusal is the point. Minting anyway would put "this principal has no
// product roles" on the token, which is indistinguishable from the truth for a
// principal who genuinely has none — a silent under-grant that surfaces as a
// mysterious 403 storm in YOUR product, with a 200 in our logs. The same rule
// ADR-097 D3 applied to a dropped claim, and the same rule otpsvc.Issue applies
// to an undelivered OTP.
type ProductRolesError struct {
	TenantID string
	UserID   string
	Attempts int
	Err      error
}

func (e *ProductRolesError) Error() string {
	return fmt.Sprintf("realmid: product_roles handler failed after %d attempts for tenant %s: %v",
		e.Attempts, e.TenantID, e.Err)
}

func (e *ProductRolesError) Unwrap() error { return e.Err }

// productRolesAttempts / productRolesBackoff are the D11 retry policy.
//
// A role lookup is a DB read and a DB read fails transiently, so the refusal is
// the LAST resort rather than the first response. Three attempts with ~50ms then
// ~150ms of backoff puts a ceiling of roughly 200ms of added latency on the
// login hot path with a human waiting — which is part of the decision, not an
// implementation detail. Deliberately NOT exponential-unbounded.
const productRolesAttempts = 3

var productRolesBackoff = []time.Duration{50 * time.Millisecond, 150 * time.Millisecond}

// resolveProductRoles runs the configured handler with the D11 retry policy.
//
// Returns (nil, nil) when no handler is configured: the claim is omitted and
// this is NOT an error. Making the handler mandatory would break every existing
// integration on upgrade for a feature they did not ask for, on top of the
// Login behaviour change D10 already imposes.
//
// EVERY error is retried and there is no taxonomy. The SDK cannot tell your
// transient DB error from a permanent one, and inventing a sentinel for you to
// wrap fails ADR-102 C0.1's bar. A deterministic failure costs ~200ms before it
// is reported, which is the price of not having a knob.
func (r *Realm) resolveProductRoles(ctx ctxpkg.Context, tenantID, userID string) ([]string, error) {
	h := r.cfg.ProductRoles
	if h == nil {
		return nil, nil
	}
	var last error
	for attempt := 0; attempt < productRolesAttempts; attempt++ {
		if attempt > 0 {
			// ABORT IMMEDIATELY if the caller's context is cancelled or past its
			// deadline. A retry loop that outlives its context turns a client
			// timeout into a server-side pileup.
			select {
			case <-ctx.Done():
				return nil, &ProductRolesError{
					TenantID: tenantID, UserID: userID,
					Attempts: attempt, Err: errors.Join(last, ctx.Err()),
				}
			case <-time.After(productRolesBackoff[attempt-1]):
			}
		}
		roles, err := h(ctx, tenantID, userID)
		if err == nil {
			return roles, nil
		}
		last = err
		// A cancelled context will not become uncancelled; stop rather than
		// burning the remaining attempts on a caller who has already left.
		if ctx.Err() != nil {
			break
		}
	}
	return nil, &ProductRolesError{
		TenantID: tenantID, UserID: userID,
		Attempts: productRolesAttempts, Err: last,
	}
}

// LoginMintError wraps a failure of the ADR-102 D10 mint that follows
// /auth/login, and CARRIES THE SESSION login already created.
//
// # Why the session travels on the error
//
// ADR-102 OQ8: the session is not litter, it is the RECOVERY ANCHOR, and that is
// the point of splitting login from the mint. Every mint-time refusal is
// recoverable from the one refresh token login handed back:
//
//	role handler failed for org A  -> choose org B (failures are often per-org)
//	412 mfa_required               -> verify, then mint
//	412 mfa_registration_required  -> enroll a first factor, then mint
//	ADR-092 session limit          -> the issuer returns the ACTIVE SESSION LIST
//	                                  and a revocation token, a surface that only
//	                                  makes sense while you still hold a usable
//	                                  refresh token
//
// A mint-or-nothing Login would strand exactly the users those affordances exist
// for. Returning (nil, err) — the obvious shape — would have done precisely
// that, because every Go caller writes `if err != nil { return nil, err }` and
// the anchor would be dropped on the floor.
//
// So the session rides ON the error, where a caller who needs it can find it and
// a caller who does not is unaffected. Use errors.As.
//
// The session is NOT revoked. The residual risk — a partner whose role DB is
// down for every tenant burning ADR-092 session slots — is bounded by D11's
// retries and by the sessions' own expiry, and is the cheaper failure of the two.
type LoginMintError struct {
	// Session is the session /auth/login created, intact and usable. Its
	// RefreshToken is the recovery anchor.
	Session *Session
	// TenantID is the tenant the mint was attempted for.
	TenantID string
	// Err is the underlying failure: a *ProductRolesError when YOUR handler gave
	// up, or a *RealmError when the ISSUER refused the mint.
	Err error
}

func (e *LoginMintError) Error() string {
	return fmt.Sprintf("realmid: login succeeded but the mint for tenant %s failed: %v",
		e.TenantID, e.Err)
}

func (e *LoginMintError) Unwrap() error { return e.Err }

package realmid

import (
	ctxpkg "context"
	"errors"
	"fmt"
)

// identity_resolved.go — the post-identity, pre-derived-claims hook.
//
// # The problem it closes
//
// A partner resolves their `scope` claim in Config.Scopes by reading their own
// local user row, and that row is written by their reconciler AFTER the session
// exists. So a brand-new user's first login resolved against a row that did not
// exist yet and was minted scope-less, which every ADR-097 gate reads as "no
// granted authority". The repair was an extra /auth/token round trip on every
// login, forever.
//
// They could not move the seeding into Scopes, and were right not to try:
// side-effect freedom is a written contract there (scopes_handler.go) backed by
// a real retry loop, so their write would have run up to three times per mint.
//
// # Why the name is not "BeforeMint"
//
// Because that would be FALSE on every lane. On the login lanes the first mint
// IS `POST /auth/login`, and identity is only known FROM its response — Login
// backfills User.ID from the access token's `sub`. On refresh the first
// /auth/token has already minted before the subject can be read at all. "After
// identity is known" and "before the first mint" are mutually exclusive.
//
// What does exist, and what closes the partner's problem, is the seam before the
// DERIVED-CLAIMS mint: the instant after (user, tenant) is settled and before
// ProductRoles and Scopes are resolved. That is where this fires, and the name
// says so.

// AuthFlow values for the lanes that resolve the derived claims but are not
// middleware routes.
//
// ⚠️ DECLARED RELATIVE to the last constant in middleware.go, so appending one
// THERE silently collides with FlowOTP here and two lanes become
// indistinguishable to a partner switching on Flow.
// TestAuthFlowValuesAreDistinct is what catches that.
const (
	// FlowOTP is AuthClient.OTPLogin.
	FlowOTP AuthFlow = FlowMFAVerify + 1 + iota
	// FlowPassword is AuthClient.PasswordLogin (ADR-104).
	FlowPassword
	// FlowTenantChoice is AuthClient.CompleteLogin — a multi-tenant login
	// settling on one tenant, or a later switch to another.
	FlowTenantChoice
)

// IdentityResolvedHandler is called once per derived-claims resolution, with the
// authenticated identity and the settled tenant, immediately BEFORE
// Config.ProductRoles and Config.Scopes are resolved.
//
// It is the SIDE-EFFECTING twin of those two handlers, and the whole reason it
// exists: they are contractually pure and retried, this one is contractually
// impure and NOT retried. Seed the row your ScopesHandler reads here.
//
// # The guarantee, stated so you can check it
//
// It fires exactly once per derived-claims resolution, on every lane where the
// resolvers run — Login, CompleteLogin, OTPLogin, PasswordLogin, MFAVerify
// (and MFAVerifyOTP through it), and REFRESH — and nowhere else.
//
// NOT "once per authentication", and the difference is not pedantic:
//
//   - A MULTI-TENANT login settles no tenant, so nothing fires. The choice does
//     (Flow: FlowTenantChoice), for the tenant your app picked. A later tenant
//     SWITCH through CompleteLogin fires it AGAIN, for the new tenant — the
//     mirror is per-tenant and the second tenant's row may not exist either.
//   - REFRESH fires it too (Flow: FlowRefresh). In a BFF deployment the refresh
//     route IS the tenant-choice route — the middleware requires tenant_id on it
//     and has no separate choice route — so a hook that skipped refresh would
//     miss the moment a new (user, tenant) pair first appears. If you do not
//     want the per-access-TTL write, that is one line:
//     `if ev.Flow == FlowRefresh { return nil }`.
//   - It does NOT fire on Auth.Token called directly (the raw mint primitive —
//     firing there would double-fire every lane above, all of which route
//     through it), and it CANNOT fire on the credential-bootstrapped lanes
//     (static API key, platform API key, ADR-057 workload federation), which
//     produce no user and no tenant. There is no identity to resolve.
//
// # A non-nil error REFUSES THE MINT. There is no fail-open knob.
//
// This is not new authority: a failing Config.Scopes already fails every login
// on the realm today, and for the same reason. Minting past a failed seed would
// hand back a token whose `scope` was resolved against a row that is missing or
// stale — a confidently wrong authority claim, recorded in our logs as a clean
// 200.
//
// Want best-effort? Handle your own error and `return nil`. That is the idiom
// MiddlewareOptions.OnAuthSuccess already prescribes, and it is why a
// configuration flag would only be a second way to say the same thing.
//
// ⚠️ IT CANNOT FAIL AN AUTHENTICATION — only the DELIVERY of a session. By the
// time it runs the issuer has authenticated the principal and the session exists
// server-side:
//
//   - Direct client: the error arrives as a *LoginMintError carrying the intact
//     session. Its refresh token is the recovery anchor (ADR-102 OQ8). Use
//     errors.As.
//   - Middleware: no refresh cookie is written and no session reaches the
//     browser, but the issuer-side session is live and orphaned until it
//     expires. Already true of a *ScopesError today; this adds no new class.
//   - REFRESH: worse, and worth knowing before an incident. The hook necessarily
//     runs AFTER the first /auth/token, so the refresh token the caller
//     presented has ALREADY ROTATED — an error there is an unrecoverable logout,
//     not a retryable failure. Also already true of a *ScopesError today.
//
// # Not retried, so it must be idempotent
//
// Exactly one invocation per resolution. On failure the retry is the USER's —
// they log in again and it fires from the top — and a tenant switch fires it a
// second time for another tenant. UPSERT, DO NOT INSERT. The SDK keeps no
// "already fired" memo: that would need an identity key, a TTL and an eviction
// policy, and it would silently stop firing after your database was restored
// from a backup.
//
// # Timeouts are YOURS
//
// The hook runs on the login hot path with a human waiting, and the SDK will
// NOT interrupt it — there is no synthetic deadline and no goroutine race,
// because abandoning a handler leaks it and lets its write land after we have
// already returned the error. The caller's own context deadline is the bound.
// Honour ctx.
type IdentityResolvedHandler func(ctx ctxpkg.Context, ev *IdentityResolvedEvent) error

// IdentityResolvedEvent is the settled identity, handed to
// IdentityResolvedHandler before the derived claims are resolved.
//
// ⚠️ MUTATING IT HAS NO EFFECT. It is a pointer for allocation reasons only; the
// SDK hands the handler its own copy and never reads it back. If the hook could
// change the tenant or the user, the resolution that follows would resolve for
// something the issuer did not authenticate. TestIdentityResolvedEventMutationIsInert
// pins that.
//
// It carries NO TOKENS, deliberately. The access token in hand at that instant
// is the PRE-derived-claims one — no `scope`, no `product_roles` — so a hook
// reading it would see absent-scope and conclude "no granted authority", the
// exact ADR-097 misreading this whole seam exists to prevent. Handing a bearer
// credential to a hook whose job is a database write is also a credential
// surface expansion for nothing.
type IdentityResolvedEvent struct {
	// Flow names the lane: FlowLogin, FlowOTP, FlowPassword, FlowMFAVerify,
	// FlowTenantChoice or FlowRefresh.
	Flow AuthFlow
	// RealmID is the realm this handle was constructed for. Never empty.
	RealmID string
	// TenantID is the settled org. Never empty — the hook does not fire until
	// a tenant is settled.
	TenantID string
	// UserID is the JWT `sub`, and never empty.
	//
	// ⚠️ IT IS A MEMBERSHIP, NOT A PERSON. `sub` is the per-tenant `users` row
	// id, so one human in two orgs has two of them. Key your mirror on
	// (TenantID, UserID); keying on UserID alone silently SPLITS one human
	// into two mirror rows.
	//
	// It cannot do the opposite. Two humans can never share a UserID: the
	// issuer's `users` is one global table with `id UUID PRIMARY KEY`, and a
	// row id is never rewritten, so a `sub` is unique platform-wide. A mirror
	// does not need to defend against a collision, only against the split.
	UserID string
	// Role is the RealmID role this principal holds in TenantID. BEST EFFORT —
	// it may be "" (notably on the refresh lane, where no membership list is in
	// hand). Not an authorization input: a role NAME confers nothing.
	Role string
	// Email is best-effort and may be "".
	Email string
	// DisplayName is best-effort and may be "".
	DisplayName string
}

// errIdentityUnresolved is the failure that has no handler error behind it: the
// SDK could not establish the identity the hook is contractually promised, so it
// refuses rather than firing with a blank subject.
var errIdentityUnresolved = errors.New("the authenticated subject could not be read")

// IdentityResolvedError reports that YOUR OnIdentityResolved hook failed — or
// that the SDK could not give it an identity — and that the SDK therefore
// refused to mint.
//
// ⚠️ Deliberately NOT a *RealmError, for the reason ScopesError gives: "your
// hook failed" and "RealmID refused your mint" are different incidents and must
// not look alike in your logs — one is your database, the other is ours.
//
// On the login lanes it arrives wrapped in a *LoginMintError, which carries the
// session login already created. Use errors.As for both.
type IdentityResolvedError struct {
	// Flow is the lane the refusal happened on. FlowRefresh means the presented
	// refresh token has already rotated: this is a logout, not a retry.
	Flow AuthFlow
	// TenantID is the settled org, or "" if that is what could not be read.
	TenantID string
	// UserID is the settled subject, or "" if that is what could not be read.
	UserID string
	// Err is your handler's error, or errIdentityUnresolved when the SDK could
	// not establish an identity to hand it.
	Err error
}

func (e *IdentityResolvedError) Error() string {
	return fmt.Sprintf("realmid: OnIdentityResolved refused the mint for tenant %s: %v",
		e.TenantID, e.Err)
}

func (e *IdentityResolvedError) Unwrap() error { return e.Err }

// fireIdentityResolved runs the configured hook exactly once, ahead of the
// derived-claims resolvers.
//
// The event is taken BY VALUE and the handler is given a pointer to this local
// copy — which is what makes a mutation inert without asking the partner to
// believe a doc comment.
//
// Returns nil when no hook is configured: this must stay free for every
// consumer who never adopts it.
//
// Refuses when the identity is incomplete, and that is the point rather than an
// edge case. The handler's contract is "identity is known"; firing it with a
// blank subject would seed a row for nobody, and NOT firing it silently is the
// exact failure this hook was built to end.
func (r *Realm) fireIdentityResolved(ctx ctxpkg.Context, ev IdentityResolvedEvent) error {
	h := r.cfg.OnIdentityResolved
	if h == nil {
		return nil
	}
	if ev.TenantID == "" || ev.UserID == "" {
		return &IdentityResolvedError{
			Flow: ev.Flow, TenantID: ev.TenantID, UserID: ev.UserID,
			Err: errIdentityUnresolved,
		}
	}
	ev.RealmID = r.realmID
	if err := h(ctx, &ev); err != nil {
		return &IdentityResolvedError{
			Flow: ev.Flow, TenantID: ev.TenantID, UserID: ev.UserID, Err: err,
		}
	}
	return nil
}

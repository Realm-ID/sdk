# TODO — `Realm-ID/sdk`

Open follow-ups for the SDK monorepo. Cross-repo items live in the umbrella
repo's `TODO.md`; design rationale lives in `DECISIONS.md`.

## Open

- [ ] 🔴 **`Auth.MFAVerify` returns a token with NO `product_roles` and NO
  `scope` — a fourth mint lane that skips the derived-claims handler.**
  CONFIRMED against source 2026-09-03 (`go/auth.go:955-985`): `MFAVerify`
  returns `&resp, nil` with **zero** calls to `mintProductRoles`, while all
  three login lanes call it — `Login` (`auth.go:557`), `CompleteLogin`
  (`:618`) and `PasswordLogin` (`:933`). `MFAVerifyOTP` delegates to
  `MFAVerify`, so it inherits the gap.
  **Impact**: a post-step-up session is role-blind. A partner who adopts
  scope-based authorization (ADR-097) is denied everywhere after any MFA
  challenge. This is the SAME shape as the refresh-lane gap fixed in
  `go/v0.54.0` — a mint lane that does not run the handler.
  **Reported by the Traide integration**, who hit it while evaluating step-up
  MFA on these routes. Verified by us, not taken on report.
  ⚠️ **Do NOT fix this as a one-off.** `middleware_derived_claims_test.go:21`
  carries a HAND-MAINTAINED comment reading *"`mintProductRoles` had three call
  sites"* — that count is how the fourth lane shipped unnoticed, and a fifth
  will do the same. The fix is a test that DERIVES the set of session-minting
  lanes from the package AST and fails when one of them does not run the
  handler, the way the issuer's `TestRoleWriteSitesAreReviewed` derives its
  seating paths. Fix the class, then the instance.
  Check `ts/` and `java/` for the same lane before closing — the issuer is
  authoritative and all three SDKs mirror it.

- [ ] **`RevocationCache` is revoke-by-jti only, so every partner builds the
  same `user → jti` index to work around it.** (Traide, 2026-09-03. FEATURE —
  needs an owner decision before any code; do not implement on this note.)
  The interface is `Revoke(ctx, jti, expiresAt)` / `IsRevoked(ctx, jti)`
  (`go/platform_token.go:315`), and the only caller is `Logout`, which works
  because the user presents their OWN access token. The actor in the common
  case is a DIFFERENT user: an owner demoting a colleague holds neither that
  colleague's token nor their jti.
  **Why it matters**: a role change lands only on the target's next refresh, so
  authority is stale for up to one `access_ttl_seconds` (default **900s**). The
  sharp case Traide names is not data exposure — where `POST /users/{id}/role`
  is callable by `admin`, a just-demoted admin can re-promote themselves inside
  that window. Bounded window, unbounded consequence.
  Same wall as `Auth.ListSessions`/`RevokeSession` since issuer `v0.66.0`: both
  need the target's own verified access JWT, and an admin acting on someone
  else never has one. **That restriction is correct and is not up for debate** —
  a platform key must not be able to act as any user. The question is whether
  "revoke this user's authority now" gets a supported path that does not
  require impersonation.
  Options Traide offered, in their order of preference: (1) `RevokeAllForUser(ctx,
  userID)` on the cache interface; (2) a way for a platform key to enumerate a
  target's live jtis without impersonating them; (3) if neither fits the model, a
  DOCUMENTED note that the index is the partner's job, so nobody assumes `Logout`
  is the whole story.
  ⚠️ Option 3 is not a cop-out and may be the right answer: the SDK cannot own a
  `user → jti` index without either persisting per-user token state it currently
  has no reason to hold, or asking the issuer for an enumeration endpoint that
  re-opens the impersonation question. But leaving it UNDOCUMENTED is the one
  choice with no defence — a missed index write is a token that silently
  survives revocation, and it looks fine until the day it does not.

## Checked and NOT a defect (do not re-file)

- `enrichRefreshMint`'s two early returns (`derived_claims_refresh.go`) were
  reported alongside the `MFAVerify` gap as "the same shape". They are not.
  Both are deliberate and carry their reasoning in-place: the peek-failure
  branch degrades to the pre-`v0.54.0` behaviour rather than breaking every
  refresh, and is pinned by regression tests that assert the subject reaches the
  handler (so it cannot silently become the normal path); the both-handlers-
  empty branch is a genuine no-op, because a re-mint could only reproduce the
  token already held. Verified against source 2026-09-03.

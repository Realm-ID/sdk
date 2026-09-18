# TODO — `Realm-ID/sdk`

Open follow-ups **specific to the Go SDK**. Cross-language and monorepo-wide
items live in [`../TODO.md`](../TODO.md); cross-repo items live in the umbrella
repo's `TODO.md`; design rationale lives in `DECISIONS.md`.

> ⚠️ **This file was ORPHANED until 2026-09-18** — nothing in the tree linked
> it, so the 🔴 below sat outside every TODO sweep and every open-item count.
> `../TODO.md` and the root `CLAUDE.md` now both point here. If you add a Go-only
> item, add it here; if it spans languages, it belongs in `../TODO.md`.

## Open

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

## Closed

- [x] 🔴 **`Auth.MFAVerify` returns a claim-blind token** — **FIXED AND RELEASED;
  closed 2026-09-18.** Commit `870d75c` (2026-09-03), *"fix(derived-claims):
  OTPLogin and MFAVerify handed back claim-blind tokens"*, wires
  `mintProductRoles` into `MFAVerify` (`go/auth.go:1061`, `FlowMFAVerify`).
  `git tag --contains 870d75c` puts it in `go/v0.57.0` onward — live in the
  released `go/v0.59.0`, and in `0.60.0`.
  Three things about the entry were wrong, which is why this note exists rather
  than a silent tick:
  - it named a FOURTH lane; the fix found a **FIFTH** (`OTPLogin`,
    `auth.go:871`) that the report never mentioned;
  - every line number in it (`auth.go:955-985`, `:557`, `:618`, `:933`) had
    moved; and
  - the "do NOT fix this as a one-off" instruction was FOLLOWED —
    `go/derived_claims_lanes_test.go` derives the set of session-minting lanes
    from the package AST and fails when one does not run the handler, replacing
    the hand-maintained "three call sites" comment that let the fourth lane
    ship. It also refuses to pass vacuously when it parses no package files.
  This item sat open for 15 days after it was fixed, in an ORPHANED file no
  sweep read. A TODO's defect description is a timestamped CLAIM, not a finding.

## Checked and NOT a defect (do not re-file)

- `enrichRefreshMint`'s two early returns (`derived_claims_refresh.go`) were
  reported alongside the `MFAVerify` gap as "the same shape". They are not.
  Both are deliberate and carry their reasoning in-place: the peek-failure
  branch degrades to the pre-`v0.54.0` behaviour rather than breaking every
  refresh, and is pinned by regression tests that assert the subject reaches the
  handler (so it cannot silently become the normal path); the both-handlers-
  empty branch is a genuine no-op, because a re-mint could only reproduce the
  token already held. Verified against source 2026-09-03.

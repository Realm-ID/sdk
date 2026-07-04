# Decision Log — Realm ID SDK monorepo

The **why** behind changes to `Realm-ID/sdk` — problem, options weighed,
decision, tradeoffs. Terse "what shipped" lives in `CHANGELOG.md`; the locked
behavioural contract lives in `SPEC.md`. This file is the running index of "why
did this change happen."

Newest first.

## 2026-07-04 — Scrub customer names + private-repo references from the public SDK repo

**Problem.** `Realm-ID/sdk` is a **public** GitHub repo (all sibling repos —
`issuer`, `api`, `ui`, `project` — are private). It carried real customer
identifiers and their internal architecture in world-readable files:

- `web/docs/a partner-migration.md` — a customer-named "fit assessment" that
  described a named partner's private React auth code **and a security
  weakness** (refresh token in `localStorage` / XSS). Not linked from anywhere.
- `SPEC.md`, `CHANGELOG.md`, `CLAUDE.md` — customer names (a partner, a partner,
  a partner) in headings and prose.
- Test fixtures (`*.go`/`*.ts`/`*.java`) — real customer domains as fixture
  values (`example.com`, `demo-app.firebaseapp.com`, `app.example.com`,
  `demo-app` Firebase project/client IDs).
- Published/READMEs + `docs/operations.md` + `web/BFF-SPEC.md` — links to the
  **private** `Realm-ID/api` / `Realm-ID/issuer` repos and internal ADR relative
  paths (dead 404s for consumers that also leak private repo structure).

**Options.** (a) Genericize `a partner-migration.md` in place; (b) delete it.
Chose **delete** — it was unreferenced, its only value (SDK-mapping walkthrough)
is already covered by `docs/quickstart.md` + `integration-guide.md`, and keeping
a genericized copy would be maintenance surface for no consumer benefit.

**Decision.** Customer identifiers → neutral placeholders
(`example.com`→`example.com`, `demo-app*`→`demo-app*`); customer names in
prose → "a partner" / "worked examples"; private-repo links → the public
`api.realmid.dev` endpoint or `BFF-SPEC.md` (the contract partners implement).
Test scrub verified with `go test ./...` (pass) and `npm test` (113/113).

**Scope tradeoff — bare ADR numbers kept.** `SPEC.md`/`CHANGELOG.md` still cite
ADR numbers as opaque text (not clickable links to the private repo). Removing
every ADR number from the locked spec + full changelog history was
disproportionate to the low leakage of an opaque identifier; only ADR
*hyperlinks/relative-paths into private repos* were removed. (The public
**website** partner guide, by contrast, was rewritten with zero ADR references —
see `website/DECISIONS.md`.)

**⚠️ Git history not rewritten.** These edits sanitize the working tree only.
The customer names and the deleted `a partner-migration.md` remain in the public
repo's **git history** and on any existing clones/forks. A history rewrite
(`git filter-repo` / BFG + force-push, re-tagging releases) is destructive and
out of scope here — flagged to the owner as a follow-up decision.

## 2026-07-01 — `restore()` must send the session bearer; tokenless sessions outlive the access-TTL (web/v0.4.4)

**Symptom.** Reloading `app.realmid.dev` more than ~15 min after the last token
mint signed the user out. A first reload often showed a degraded page
(`network error calling GET /admin/platforms: no current tenant`) while still
"logged in"; a second reload logged out outright. This persisted after the BFF
`/me` self-heal (api v0.15.4) fixed the server half.

**Root cause (client half, `@realm-id/web`).** Two defects in
`packages/core/src/realm.ts`, both around session restore under the BFF /
tokenless-rotation model (where the client holds an opaque, durable session
bearer `rsid_…` that the BFF rotates server-side, and `Authorization: Bearer
rsid_…` is the *only* accepted credential — no cookie):

1. **`restore()` sent a bearerless `/me`.** It called
   `transport.request("GET", /me, { gates })` with no `accessToken`, so no
   `Authorization` header went out. The BFF's `loadSession` returns 401
   `session_missing` ("missing session bearer") for that, so the background
   revalidation *always* failed and `restore()` dropped the session to
   anonymous + cleared storage — racing the app's own authed `/me` (which does
   attach the bearer via `realm.fetch`). That race produced both the transient
   `no current tenant` and the sign-out. The refresh path already attached
   `this.tokens.peek()` (with a comment naming this exact failure); `restore()`
   was simply never given the same treatment.
2. **`readStoredSession` discarded the durable session at the 15m access-TTL.**
   It cleared storage and returned null when the snapshot's `expiresAt` (the
   short-lived access-JWT hint) passed. Under tokenless rotation the stored
   `accessToken` is the *durable* session bearer, not a self-expiring token, so
   discarding it threw away the credential — leaving `restore()` with nothing
   to attach even after fix (1), so a >15m reload still had no bearer.

**Why it wasn't caught.** The existing restore test's mock `/me` returned 200
regardless of the `Authorization` header, so a bearerless `/me` "passed" in the
suite while failing against the real BFF — the same fake-vs-real gap that has
bitten this platform before. The deterministic trigger (a real >15m-expired
session) never ran in CI.

**Decision.**
- `restore()` attaches `accessToken: this.tokens.peek() ?? undefined` so the
  revalidation is authenticated in every mode (correct for classic self-expiring
  bearers too; `undefined` on a genuine cold start keeps the anonymous probe).
- `readStoredSession` skips the `expiresAt` discard **only** when
  `refresh.tokenless` is set — the flag that means "the stored bearer is the
  durable, server-rotated session token." The snapshot is adopted (optimistic
  paint) and `restore()`'s authenticated `/me` becomes the sole authority on
  validity, clearing storage on a real 401. Classic mode is untouched.
- Gated on `tokenless` rather than removing the expiry check outright so
  non-BFF consumers (stored token IS the access token) keep the "don't paint
  state we're about to throw away" behaviour.

**Tests.** Rewrote the restore mock to be BFF-faithful (401 `session_missing`
without an `Authorization` bearer). Two regression tests — `restore()` must
carry the bearer; a tokenless reload >15m after mint keeps the session — both
went red against the pre-fix code, reproducing the prod sign-out, then green.

**Prevention.** SDK tests that model the BFF must reject a bearerless
authenticated call, not accept it. Any authenticated background call the SDK
makes on the user's behalf (restore, poll, revalidate) must attach the session
bearer, mirroring `realm.fetch`. Pairs with api v0.15.4 (`DECISIONS.md` there).

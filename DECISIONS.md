# Decision Log — Realm ID SDK monorepo

The **why** behind changes to `Realm-ID/sdk` — problem, options weighed,
decision, tradeoffs. Terse "what shipped" lives in `CHANGELOG.md`; the locked
behavioural contract lives in `SPEC.md`. This file is the running index of "why
did this change happen."

Newest first.

## 2026-07-04 — Purge partner identifiers + private-repo references from the public SDK repo (working tree + history)

**Problem.** `Realm-ID/sdk` is a **public** GitHub repo (all sibling repos —
`issuer`, `api`, `ui`, `project` — are private). It carried three partner
names, their real production domains, and their internal architecture in
world-readable files:

- An unreferenced customer-named "fit assessment" doc under `web/docs/` that
  described a named partner's private React auth code **and a security
  weakness** (refresh token in `localStorage` / XSS).
- `SPEC.md`, `CHANGELOG.md`, `CLAUDE.md` — partner names in headings and prose.
- Test fixtures (`*.go`/`*.ts`/`*.java`) — real partner domains and Firebase
  project/client IDs as fixture values.
- Published READMEs + `docs/operations.md` + `web/BFF-SPEC.md` — links to the
  **private** `Realm-ID/api` / `Realm-ID/issuer` repos and internal ADR relative
  paths (dead 404s that also leak private repo structure).

**Working-tree scrub.** Partner identifiers → neutral placeholders (a neutral
`example.com` audience, a `demo-app` Firebase project); partner names in prose →
"a partner" / "worked examples"; the fit-assessment doc deleted (unreferenced;
its SDK-mapping value is covered by `docs/quickstart.md` + `integration-guide.md`);
private-repo links → the public `api.realmid.dev` endpoint or `BFF-SPEC.md`.
Verified with `go test ./...` (pass) and `npm test` (113/113).

**History rewrite — decided against the recommendation.** The scrub alone left
the identifiers in git history and, critically, in the **Go module proxy**:
`proxy.golang.org` had already cached every published `go/vX.Y.Z` version, and
those cached zips (with the partner names in test fixtures) are immutable and
**cannot be recalled** by any GitHub rewrite. The owner chose a full
`git filter-repo` rewrite anyway, accepting two known costs: (1) it does **not**
purge the Go-proxy copies, so the honest mitigation remains **notifying the named
partners**; (2) rewriting the `go/` test fixtures changes the module content
hash, so `sum.golang.org` will report a checksum mismatch for previously
published Go versions fetched fresh (cache-miss) after the force-push — existing
consumers should move to a newly cut version. Executed via `--replace-text`
(all partner tokens across all blobs) + `--invert-paths` (remove the doc from
every commit); 48 tags repointed; `main` + tags force-pushed. Pre-rewrite state
bundled to `/tmp/sdk-history-rewrite/sdk-pre-rewrite.bundle` for recovery.

**Scope note — bare ADR numbers kept.** `SPEC.md`/`CHANGELOG.md` still cite ADR
numbers as opaque text; only ADR *hyperlinks/relative-paths into private repos*
were removed. (The public **website** partner guide was rewritten with zero ADR
references — see `website/DECISIONS.md`.)

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

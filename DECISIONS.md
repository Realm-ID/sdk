# Decision Log — Realm ID SDK monorepo

The **why** behind changes to `Realm-ID/sdk` — problem, options weighed,
decision, tradeoffs. Terse "what shipped" lives in `CHANGELOG.md`; the locked
behavioural contract lives in `SPEC.md`. This file is the running index of "why
did this change happen."

Newest first.

## 2026-07-10 — SPEC §3: document the uniform-200 success/envelope contract (issuer ADR-069)

**Problem.** The issuer reconciled a wire-vs-swagger drift (ADR-069): ~30
POST/DELETE endpoints had been shipping GoFr-native `201`/`204` while swagger
documented `200`. The corrected contract is a uniform `200` `{data:...}` envelope
with `201` only for genuine resource creation, and `200`-with-body for all
DELETEs. SPEC.md never stated the success-status boundary explicitly.

**Decision.** Add the success-vs-failure rule to SPEC §3: success is the **entire
`2xx` class** (never an exact `200` check), with the envelope + the 201-create
exception spelled out. **Descriptive only** — every SDK already implements exactly
this (Go `< 400`, TS `resp.ok`, Java `200 ≤ s < 300`; the CLI's `exitForStatus`
treats `< 400` as OK), so ADR-069 is backward-compatible and needs **no SDK code
change and no version bump**. Verified all three transports + the CLI before
writing.

**Tradeoff.** Documenting an already-honored behavior risks looking like a no-op,
but the explicit boundary is what stops a future SDK author (or a raw-HTTP partner)
from reintroducing an exact-`200` check that the ~30 drifted endpoints would break.

## 2026-07-09 — `refresh_exp` on the wire (SPEC §4.1) + drop the dead `Origin.DetachedAt`

Two SDK-contract changes cut together (go/v0.26.0 + ts-v0.17.0 + java-v0.15.0).

### `refresh_exp` — surface the refresh token's absolute expiry (#10)

**Problem.** `Session`/`MintResult` carried only `expires_in` (the *access*
token TTL). The refresh token's absolute expiry — computed issuer-side as the
min of the rolling TTL, the ADR-054 scheduled cutoff, and the ADR-058 absolute
session cap — was never surfaced. A consumer that sizes a session from the
refresh lifetime (the BFF session store) had to *guess* it: `api/` hardcoded a
30-day ceiling (`buildRecord`). That guess diverges from realm policy — a realm
with a >30d refresh evicts live sessions early; a <30d realm keeps a dead
session "alive" until the next refresh fails.

**Decision.** Add `refresh_exp` (unix seconds) to the login (`§4.1`) and token
(`§4.2`) responses, wired through all three SDKs (`Session.RefreshExp`,
`MintResult.RefreshExp`; TS `refreshExp?`; Java `refreshExp`). **Optional /
forward-compatible:** absent decodes as `0`/`undefined`, and consumers MUST fall
back to a local ceiling on the zero value — so a new SDK against an old issuer,
or an old SDK against a new issuer, both keep working. Options weighed:
(a) surface it on the wire *(chosen — honest, one source of truth in realm
config)*; (b) have the BFF re-read `refresh_absolute_expiry` from realm config
on every login *(rejected — couples the BFF to issuer config semantics + adds a
config fetch on the hot path)*; (c) leave the 30d guess *(rejected — wrong for
any realm that overrides the default)*. Issuer emit lands in `v0.28.0`; BFF
consume in `v0.17.0`.

### Drop `Origin.DetachedAt` — it was dead code re-arming the v0.21.0 outage (#7)

**Problem.** Go `Origin` declared `DetachedAt *string json:"detached_at"` and
`fetchAllowlist` skipped rows where it was set. But the issuer's
`domainMappingDTO` **never serializes `detached_at`**, and the origins list is
already filtered to live rows server-side (`ListByEntity` → `detached_at IS
NULL`). So the field was always `nil` and the filter never fired — dead code.
Worse, it re-armed the exact go/v0.21.0 outage class: the `created_at` comment
right above it documents that a `*string` field receiving a JSON *number* throws
on the origins hot-path decode. If anyone ever added `detached_at` to the DTO
the natural way (`.Unix()` → a number), sign-in would break again.

**Decision.** Delete the field + the dead filter. The SDK uses plain
`encoding/json` (no `DisallowUnknownFields` — verified), so a future
`detached_at` on the wire is harmlessly ignored; keeping the mistyped `*string`
was the *only* dangerous state. Considered retyping to `*int64` for
forward-compatible defense-in-depth, but the server-side filter is the actual
contract and removal is the smaller, safer surface.

## 2026-07-08 — `SessionInfo` last-used timestamp reconciled to the issuer's `last_seen_at` field (Go / TS / Java)

**Symptom.** `ListSessions`/`listSessions` returned session records whose
last-used timestamp was always empty — Go `SessionInfo.LastUsedAt == 0`, Java
`Session#lastUsedAt() == null`, TS `SessionInfo` never carried the value at
runtime. Session creation time populated fine; only the "last active" column was
dead.

**Root cause.** Field-name drift between the issuer's serializer and every SDK.
The issuer's `sessionDTO` emits the last-used timestamp as **`last_seen_at`**
(verified: `issuer/internal/httpapi/sessions.go`, `LastSeenAt int64
\`json:"last_seen_at,omitempty"\``, set via `s.LastSeenAt.Unix()` — int64 unix
seconds). All three SDKs decoded **`last_used_at`** instead:
- Go: the `SessionInfo.LastUsedAt` json tag *and* the live `decodeSessionPage`
  path read `intField(obj, "last_used_at")`.
- Java: `Session` record `@JsonProperty("last_used_at")`.
- TS: `SessionInfo` used camelCase `lastUsedAt?: string`, but `listSessions`
  returns the parsed server JSON with **no snake→camel mapping** (unlike
  `login`, which maps via `mapAuthResp`), so both the name *and* the case were
  wrong and the field silently fell into the `[k: string]: unknown` index
  signature.

This was independent of the v0.22.0 timestamp outage: that fix corrected the
wire *type* (`string`→`int64`) but left the field *name* wrong, so `LastUsedAt`
stayed zero.

**Why it wasn't caught.** The existing `ListSessions` tests asserted only
`id`/`created_at`; no test exercised the last-used field, and `created_at`
happened to match the wire name, masking the drift. The SDKs are decoded against
hand-built mock payloads, never against a real issuer `sessionDTO`, so the
name mismatch never surfaced. TS additionally has no compile-time guard because
`listSessions` casts untransformed server JSON straight to the interface.

**Fix.** Point every SDK at the verified server field name (`last_seen_at`,
int64 unix seconds), keeping each language's public accessor name
(`LastUsedAt`/`lastUsedAt()`) for API stability and cross-language parity:
- Go: json tag `last_used_at`→`last_seen_at` on `SessionInfo.LastUsedAt`, and
  `decodeSessionPage` now reads `last_seen_at` (the live path).
- Java: `Session` `@JsonProperty("last_seen_at")` + `@JsonAlias` retains the old
  names defensively.
- TS: `SessionInfo` rewritten to the honest wire shape (`id`, `origin?`,
  `device_name?`, `created_at?: number`, `last_seen_at?: number`) since
  `listSessions` does no key mapping — the old camelCase fields were never
  populated. Dropped the phantom `userAgent`/`ip` fields the `sessionDTO`
  doesn't emit.

**Regression guard.** Go: a direct-unmarshal test of a representative issuer
payload (`TestSessionInfo_UnmarshalIssuerPayload`) plus an extended
`ListSessions` decode assertion. TS: `auth.listSessions` test asserting
`last_seen_at` decodes. Java: `listSessionsDecodesLastSeenAt`.

**Prevention.** All three regression tests key their payloads off the real
`sessionDTO` field names, so a future rename on either side breaks a test. TODO
item ticked off. (Broader class — the SDKs decode against mock payloads, not a
live issuer response — remains; a contract test against the issuer's actual DTO
would be the durable fix, noted for later.)

## 2026-07-05 — `@realm-id/web@0.4.5`: `resolveTenant()` — complete a tenant-picker gate without re-running the provider redirect

**Symptom.** Microsoft sign-in on a realm-root origin (`app.realmid.dev`) bounced
through the IdP **twice**: click "Log in with Microsoft" → Microsoft →
platform-picker → **Microsoft again** (a flash of the IdP) → dashboard.

**Root cause.** The OIDC redirect driver (`signIn`/`completeSignIn`) exchanges
the auth code for an `id_token`, calls `login(...)`, and — crucially — **does
not retain that `id_token`**; it's a local in `completeSignIn`. When the login
gates on `tenants_required` (a user in ≥2 platforms), the app had no token to
re-submit, so its only way to attach the chosen tenant was to call `signIn`
again — a full new OIDC authorize/redirect round-trip. The Firebase/Google-popup
path never showed this because the *app* (AuthGate) holds that `idToken` in React
state and re-submits it directly; only the redirect providers (microsoft/google
OIDC), whose token lives inside the SDK, were affected.

**Options.** (a) Surface the `id_token` in the `tenants_required` error body so
the app can re-submit it — rejected: leaks the raw provider token into app state
for no benefit. (b) **Retain the provider credential inside the SDK across the
gate and expose `resolveTenant(tenantId)`** that re-POSTs `/login` with the same
`{method, providerToken}` + the picked tenant — chosen: keeps the token
encapsulated, single-use (cleared on session-issue and on anon/logout), and gives
the app one uniform call for both popup and redirect providers.

**Tradeoff / scope.** Retention is triggered on `tenants_required` only. The
`session_limit_reached` provider-retry path still re-redirects (`signIn`); it's a
rarer flow and a genuine re-auth-after-revoke, tracked in `TODO.md` rather than
widened here. Reusing the same `id_token` seconds later is well within Entra's
token lifetime and passes the issuer's Microsoft verifier identically.

**Verified.** Additive + backward-compatible (patch; peers pin `^0.4.0`).
Unit test `realm.test.ts` "resolveTenant re-submits the SAME provider token…"
asserts exactly two `/login` calls (gated + resolved), the second carrying the
original token + chosen tenant, and single-use exhaustion. UI wiring (AuthGate +
vendored-tarball bump) lands in `Realm-ID/ui`.

## 2026-07-05 — `go/v0.25.0`: retire the deprecated `method` login field on the RIGHT hop (ADR-051)

**Problem.** ADR-051 deprecated the `method` field on the issuer's `/auth/login`
in favour of `grant_type` (+ `provider`), with a hard Sunset of **2026-08-01**.
After 0.3.5 mistargeted this on the web SDK (see the 0.3.6 entry below), the
migration was re-scoped to where the deprecated field actually lives: the
**BFF→issuer** hop, sent by the Go SDK (`sdk/go/auth.go`).

**Decision.** `Auth.Login` sends `grant_type=provider_token`+`provider=<idp>`;
`OTPLogin` sends `grant_type=otp_internal`. Both drop `method`.

- **Why fixed grant, not a method→grant map in the SDK?** `Auth.Login` is
  definitionally a provider-token exchange — `LoginMethod` only ever names an IdP
  (firebase/google/microsoft). So the grant is a constant and the method string
  is exactly the `provider` hint the issuer wants. A lookup table would only
  re-encode what the issuer's `legacyMethodToGrant` already did, on the wrong
  side of the wire.
- **Public API preserved.** Callers still pass `LoginMethod`; the change is
  wire-only. No BFF handler change needed — it already forwards `LoginMethod`
  through `realmid.LoginRequest`.
- **Tradeoff / sequencing.** The BFF (`api/`) was pinned at `sdk/go v0.21.0`;
  shipping this needs a bump to v0.25.0 + a BFF redeploy. Safe: v0.22 (timestamp
  hotfix) + v0.23/v0.24 (additive) carry no breaking change, verified by building
  the BFF against the local SDK. Against issuer ≥v0.27.1 there is zero
  behavioural change (it accepts both forms); the win is that the issuer's compat
  shim becomes dead code the moment every caller is ≥0.25.0, deletable at sunset.
- **Not touched.** `MFAVerify`'s `method` is the MFA-factor selector
  (totp/otp_internal) on `/auth/mfa/verify`, unrelated to the ADR-051 login
  selector — left as-is.

Links: `CHANGELOG.md` go/v0.25.0; issuer `internal/httpapi/auth.go`
`legacyMethodToGrant`; ADR-051.

## 2026-07-05 — `web-bff-realmid@0.3.6`: revert 0.3.5 — the web SDK migration targeted the wrong hop

**What went wrong.** 0.3.5 changed the web SDK's `/login` body from `method` to
`grant_type=provider_token`+`provider`, on the premise that the web SDK rode the
ADR-051-deprecated `method` field. It does not. The web SDK talks to the **BFF**
(`api.realmid.dev`), whose `/login` is a typed handler with its OWN contract —
`{ method, token }` (`api/internal/handlers/handlers.go` rejects a missing
`method` with `method and token are required`). The deprecated issuer `method`
field is on the **BFF→issuer** hop, sent by the **Go SDK** (`sdk/go/auth.go`).
0.3.5 therefore broke login (`method and token are required`) while touching a
non-deprecated contract.

**Correction.** Revert the login adapter to send `method` (0.3.6, re-vendored as
ui v0.11.4). The original Microsoft bug was already fixed by issuer v0.27.1 (the
shim maps `method:"microsoft"` on the Go SDK hop); the web SDK change was
unnecessary. The REAL migration — retiring the deprecated field before the
2026-08-01 sunset — is a **Go SDK** change (`auth.go` login body: send
`grant_type`+`provider`) plus a BFF go.mod bump, tracked in root `TODO.md`. The
web↔BFF `method` contract is the BFF's own API and stays.

**Lesson.** Identify which hop owns a field before "migrating" it. Two services
can name a field `method` and mean different contracts; the deprecation applied
to only one of them.

## 2026-07-05 — `web-bff-realmid@0.3.5`: migrate login off the deprecated `method` field to `grant_type`

**Problem.** ADR-051 (issuer v0.7.0) reworked `/auth/login` to dispatch on
`grant_type` and deprecated the `method` field with a hard Sunset of 2026-08-01.
The server migrated; the web SDK never did — its login adapter still sent
`{ method }`, so EVERY web login (google/firebase/microsoft) rode the issuer's
`legacyMethodToGrant` compat shim. The deprecated field was the *only* path the
live web app used. That inversion caused the Microsoft outage: microsoft was
added as a provider everywhere except the shim's lookup table, so login failed
`grant_type is required` (patched issuer-side in v0.27.1 by adding the case).

**Decision.** Fix the client, not just the shim: the adapter now emits
`grant_type=provider_token` + `provider=<idp>` for provider logins,
`grant_type=otp_internal` for OTP, `grant_type=password` for native password, and
falls back to `method` only for methods without a first-class grant. The mapping
mirrors the issuer's `legacyMethodToGrant` exactly, so downstream behavior is
identical — only the dispatch key moves onto the wire.

**Why this is the real fix.** The issuer v0.27.1 shim patch unblocked prod, but
left the deprecated path load-bearing: at Sunset, removing the shim would take
all web login down. With the SDK on `grant_type`, provider logins no longer
depend on the shim at all, and the issuer can delete it on schedule. The shim
stays until Sunset only for any *other* legacy clients.

**Tradeoff.** Requires a re-vendor into `ui/web` (0.3.4 → 0.3.5) and a UI deploy.
Verified: bff-realmid tests assert the new wire shape (grant_type + provider, no
`method`); the full ui/web suite is green against the re-vendored SDK. See
`issuer/DECISIONS.md` (2026-07-05) for the RCA and root `TODO.md` for the shim
removal at Sunset.

## 2026-07-05 — `web-bff-realmid@0.3.4`: bump forced by a fix that shipped without a version bump

**Symptom.** Microsoft sign-in on prod threw `no microsoft provider configured
for this realm`, even though the base realm's Microsoft provider was correctly
configured (verified against the live BFF endpoint). Google/Firebase worked.

**Root cause.** The BFF's public providers response names the provider field
`type`; the `realmidBffPreset()` `adaptProviders` adapter read `provider`,
mapping Microsoft's provider to `""`. `resolveProvider` — reached **only** by
the OIDC/PKCE `signIn` path (Microsoft; Google/Firebase use the Firebase popup)
— then found no matching row and threw. Latent until the first Microsoft login.

**Why it wasn't caught (the real decision here).** The adapter code was *already
fixed* in `014bf4e` (`p.type ?? p.provider`), but that commit **did not bump the
version** — so the vendored `realm-id-web-bff-realmid-0.3.3.tgz` in `ui/web`,
packed before the fix, still carried the bug. Same version string, two different
contents. The pre-existing adapter test also mocked the *wrong* wire field
(`provider:` instead of `type:`), so it passed against buggy code.

**Decision.** Bump to `0.3.4` (content changed ⇒ version must change — the rule
`014bf4e` broke) to force a re-vendor into `ui/web`, and add a regression test
that uses the **real** wire shape (`type`, no `provider`). Consumers pin these
by tarball filename, so a version bump is the only reliable re-vendor trigger.

**Tradeoff / follow-up.** Vendored tarballs (not npm) mean drift like this is
invisible until someone re-packs. Longer-term fix is publishing `@realm-id/web*`
to npm (already the stated end-state in `ui/web/vendor/README.md`); until then,
"bump on every content change" is the discipline that prevents recurrence.

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

## 2026-06 — session-limit 412 gate: collect the issuer's nested-error siblings

**Symptom.** The UI's `SessionLimitModal` had no `revocation_token`/`active_sessions` to
list sessions — the BFF flattened the 412 to `{code, message}`.

**Root cause (in the SDK, not the BFF).** The issuer nests the gate fields *inside* the
error object (`{error:{code,message,revocation_token,active_sessions}}`), but `sdk/go`
`mapErrorResponse` only collected siblings from the **top level** → `RealmError.Details`
empty → the BFF had nothing to carry.

**Decision.** `sdk/go` `http.go` now collects nested-error siblings; api `MapSDKError`
carries `Details` onto the envelope via `ErrWithDetails`. Unit-tested both sides
(`http_test.go`, `errors_test.go`). The same nested-collection fix also unblocked the
MFA-registration gate payloads. **Shipped** — `sdk/go` first tag `go/v0.17.0`, `api/go.mod`
pins `v0.21.0` (≥ the fix), and `session-limit.spec.ts` is un-skipped (verified 2026-07-04).

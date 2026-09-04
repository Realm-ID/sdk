# Changelog — `@realm-id/web` (browser core)

All notable changes to the browser core SDK. Published to npm from
`.github/workflows/publish-npm.yml`; the monorepo-level `../../../CHANGELOG.md`
records cross-cutting items affecting every SDK at once.

> **This file starts at `0.4.5` (created 2026-08-24).** The package had shipped
> nine versions with no changelog of any kind — not a gap in this file, the
> absence of the file — so its history lives only in
> `git log -- web/packages/core`. Nothing is backfilled here rather than
> reconstructed from commit subjects and presented as a record; the versions
> before `0.4.5` are read from git.
>
> A release can no longer skip this file: `scripts/changelog-hygiene.sh npm`
> refuses to publish a version with no `## <version>` heading below.

## 0.7.0 — `token_stale` is a 401 that must never end the session (ADR-107) (2026-09-04)

### Changed — a demoted or promoted user is no longer signed out

`classifyHttpStatus` reads the `token_stale` wire code off the body BY NAME.
Deliberately not a blanket "trust the body's code" rule — `.code` stays a
classification and `.body.code` stays the fact — but this one code cannot be
inferred from a 401 whose message is prose, and misreading it as `unauthorized`
signs the user out on PROMOTION, on a grant that just widened their access.

`restore()` no longer drops the session to anonymous on it. Demotion narrows the
token; it does not end the session (ADR-107 D11).

### Added — the forced refresh is capped at once per token

`realm.fetch` refreshes once on `token_stale` and replays. A second
`token_stale` on a token that forced refresh itself produced surfaces the 401
instead of minting again — otherwise a marker sitting ahead of the issuer's
clock puts every tab into an unbounded refresh loop against the mint endpoint,
which ADR-107 C5 calls a worse outcome than the window it closes.

The cap is `token_stale`-specific: ordinary 401s still refresh as before, and a
test asserts that so the cap cannot silently widen.

## 0.6.0 — the credential grant reaches the browser core (ADR-103/104) (2026-09-01)

- `LoginRequest` gains `identifier` and `presented`, the handle and secret of a
  CREDENTIAL grant (`password` or `otp`). The identifier may be an email, an
  E.164 phone, or a username.
- ⚠️ **`identifier` is passed through VERBATIM.** The issuer classifies it ONCE
  against three disjoint grammars, so no layer between the input field and the
  issuer may reshape it — a transport that trimmed or lower-cased or "fixed" a
  phone number would make the resolved identity depend on which door the request
  came through. Normalising a phone is the UI's job, at the input, exactly once.
- `ProvidersResponse` gains `credentialMethods`: the non-IdP login methods the
  realm can actually complete. **Absent means "the server did not say", never
  "none"** — an older issuer omits the field, and reading absence as an empty
  list tells a login page that credential login is off when it is not.

## 0.5.0 — step-up retry, membership self-service, the pre-session revocation flow (2026-08-30)

Additive; nothing existing changed shape. The package stays **dependency-free at
runtime** — `@realm-id/sdk` is a devDependency, used only by the parity tests
described below.

- **`withStepUpRetry(fetch, deps)`** (ADR-096 D8) — wrap the `fetch` you hand to
  `createRealm` and every gated operation answers its own `412`: classify →
  prompt → verify → replay. The prompt is a CALLBACK on `deps`, so two realms on
  one page cannot share a dialog. Four behaviours it exists to get right, each
  silent when broken and each separately mutation-tested: `mfa_required` vs
  `mfa_registration_required` (ADR-096 D4 — an enroll challenge has no code to
  collect) vs **the session-limit 412, which must FALL THROUGH untouched**;
  ADOPT the session `/auth/mfa/verify` newly mints (the presented one is
  deleted, so reusing it logs the user out on a SUCCESSFUL verify); carry the
  current bearer on the verify so the proof lands on the tenant the user is
  acting in (ADR-059); replay through the RAW fetch EXACTLY once, so a gate the
  user cannot satisfy costs one prompt and not a loop.
- **`createMemberships(realm, {baseUrl})`** (ADR-092 D5) — `chooseTenant`,
  `acceptInvitation`, `rejectInvitation`, `leave` against the BFF's typed
  `/me/*` routes, with the SESSION bearer (marking them anonymous gets
  `401 session_missing`). Plus `MEMBERSHIP_ACTION_CODES` /
  `MembershipActionCode` / `membershipActionCode(err)` /
  `isMembershipActionCode(err)`. **The codes are contract; the sentences are
  not** — the wording is product voice and stays in the application.
  `membershipActionCode` reads the code from all three places a transport may
  park it (`.code`, `.details.server_code`, `.body`), because a browser app
  commonly holds two different `RealmError` classes at once.
- **`createRevocationSessions(realm, {baseUrl})`** — `list` / `revoke` bearing
  the one-shot `revocation_token` off a `session_limit_reached` envelope
  (BFF-SPEC item 6). Anonymous with an explicit bearer: there is no session yet.
  The row type `RevocableSession` is now the single owner of that shape;
  `@realm-id/web-admin` re-exports it as `ActiveSession` instead of declaring a
  second copy.
- **`unwrapData` / `parseErrorEnvelope` + `ErrorEnvelope`** — the GoFr wire
  envelope, including the CODE-LESS framework `401` that every hand-rolled copy
  forgets. `@realm-id/sdk` OWNS this contract; the implementation here exists
  only because this package takes no runtime dependencies, and
  `envelope.test.ts` runs both over the same fixture table (23 bodies × 7
  statuses) and fails on any divergence. NOT the same function as
  `unwrapEnvelope` in `transport.ts`, which unwraps only when `data` is the sole
  key — both rules are deliberate.
- **`ProvidersResponse.tenantId`** and **`IdentityProvider.nickname`** — the two
  fields a login page needed that discovery was already returning and the SDK
  was dropping, which is why every console re-fetched `/identity-providers` by
  hand. Mapped by `@realm-id/web-bff-realmid` `0.4.0`.

## 0.4.5 — `resolveTenant()` completes a tenant-picker gate without a second provider redirect (2026-07-05)

Provider-driven logins (`signIn` / `completeSignIn`) retain the exchanged
provider token across a `tenants_required` gate and expose
`realm.resolveTenant(tenantId)`, which re-submits the SAME token with the chosen
tenant instead of re-running the OIDC redirect. Fixes the Microsoft double
round-trip (IdP → picker → IdP → dashboard) on realm-root origins.

The retained token is single-use — cleared on session-issue and on
anon/logout. Additive and backward-compatible (peers pin `^0.4.0`). New error
code `no_pending_login`.

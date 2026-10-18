# TODO — sdk/ (go · ts · java · web)

> **Open and actionable only.** Work that is decided-but-not-now lives in
> [`BACKLOG.md`](BACKLOG.md); anything needing an ADR or an owner ruling lives
> in [`OPEN-QUESTIONS.md`](OPEN-QUESTIONS.md); closed and retired records live
> in [`TODO-ARCHIVE.md`](TODO-ARCHIVE.md). An entry belongs here only if
> someone could pick it up today and finish it.

Open work only; shipped items live in `CHANGELOG.md` + `DECISIONS.md`.
`SPEC.md` is law — if a language SDK and the SPEC disagree, fix the SDK.

> ⚠️ **`go/TODO.md` is GONE as of 2026-09-18 — this is the only TODO file in
> this repo.** It was orphaned (nothing referenced it, so its 🔴 sat outside
> every sweep), and linking it exposed a second problem: **a file under `go/`
> is inside the Go module.** `TODO.md` shipped in the published module zip at
> `go/v0.60.0` — 4,681 bytes, confirmed against `proxy.golang.org` — so every
> edit to it changed the module's content hash and `tag-hygiene.sh
> unreleased-go` correctly refused the push until `const Version` was bumped.
> A TODO sweep must not be able to force a Go SDK release. Go-only items now
> live here, under *Go SDK only*.

---

- [ ] **ts and java sdk-e2e (`tests/sdk-e2e`, live issuer) have not been run for the v0.63 session surface** (recovery-code redeem, the per-session
  refresh lock, `revoked_sids`, required session store); Go's was run (sdk-e2e/go). `tests/sdk-e2e/ts` and `tests/sdk-e2e/java` hold only the
  device-name, integration-install and org-access/password cases. Also no independent critic pass on the java v0.63 parity or the ts round (ts/java
  were released 2026-10-16 on test evidence alone: `V063*`/`V064*` java tests, `ts/src/v064-lock.test.ts`). Owner ruling 2026-10-16 asked for both before the tags.
  **Ruling 2026-10-17: run both now, after the fact; any defect ships as ts `0.55.x` / java `0.51.x`** (root `DECISIONS.md` 2026-10-17).

- [ ] **`@realm-id/web` peer ranges exclude `0.9.0` and `0.10.0`** — `web-admin` (`^0.5.0 … ^0.8.0`), `web-react`, `web-firebase` and `web-google`
  (`^0.4.0 … ^0.8.0`) still stop at `0.8.0` (a `0.x` caret never reaches `0.9.0`); only `web-bff-realmid` `0.7.0` was widened. Core is `0.10.0`. Widen and release
  them when an app needs core `0.9.0`/`0.10.0` alongside them (npm will warn on peer conflict until then).

- [ ] Remaining partner-facing gaps (lower priority): `GET /me` caller identity;
  realm origin BIND (`POST /platforms/{id}/origins`). Tenant domain detach and origin delete shipped in
  go `0.67.0` / ts `0.55.0` / java `0.51.0` (`DetachDomain`, `Origins.Delete`, `detachDomain`, `OriginsClient.remove`).
  Operator/base-realm surfaces (platform create/rename, `/admin/*`
  suspend/rotate/notes) are intentionally out of the partner SDK.

## `@realm-id/web-admin` gaps (the UI carries shims until these land)

Consolidated from `ui/TODO.md` — the UI-side shim locations are tracked there;
this is the SDK-side work.

- [ ] **`RolesClient` is realmId-bound at construction.** A per-call `realmId`
  override would help cross-realm ops UIs. Not blocking today — the UI works
  around it with `useAdminForRealm(realmId)`, which returns a realm-scoped cached
  `Admin`.

## Web-package test infra

- [ ] **`web/packages/firebase/` + `web/packages/react/` are untested**
  (`google/` was backfilled 2026-06-03 with 12 tests). `firebase` statically
  imports `firebase/app` + `firebase/auth` at module top level, which
  `node --test` can't mock without a module-mock framework; `react` bindings are
  hooks needing jsdom + react-dom, neither configured in this monorepo. Needs a
  test-infra decision — add `vitest`/jsdom, or refactor firebase to inject its
  `signInWith*` seams — before either can be cleanly unit-tested.

## Integration-guide improvements from the Traide exchange (2026-08-31)

Derived from a live partner incident and the two-round exchange that followed,
NOT from a review pass. Each item is something a partner actually got wrong, or
that we got wrong answering them. Ordered by what would have prevented the most.

1. **State that the `role` claim is a partner-visible CONTRACT.** The claim
   carries `users.role` verbatim (`issuer/internal/tokens/tokens.go:52`), and
   partners key their own authorization off that string — Traide's GoFr RBAC
   reads `jwtClaimPath: "role"` against their own catalog. The guide never says
   this, so a partner cannot know a role rename is a breaking change for them.
   **Say it, and say the corollary**: do NOT key product authorization off the
   RealmID role name; that is what ADR-097 `scope` is for. ADR-040 recorded this
   coupling years ago and the guide never carried it forward.

2. **Document the scoped-token CUTOVER, not just the mint.** §4.2 says how to
   ask for a scope; nothing says how to adopt one on a running system. Needs:
   the mint must sit immediately after login and not only on the refresh path
   (because `/auth/login` can NEVER mint a scope, so a login-only population
   never converges); mint with the gate OFF, wait one refresh cycle — NOT
   `access_ttl_seconds` — then observe mode, then enforce; and if an overlap
   shim is needed, it must distinguish ABSENT scope (legacy) from
   PRESENT-but-insufficient, invert `scopeAllows`'s fail-closed default only
   inside the partner's own wrapper, and carry a date plus a removal ticket in
   the same commit.

3. **Warn that a partner's own test doubles can hide contract drift.** Traide's
   `stubissuer` echoes any role name back as `active` with no catalog check, so
   their suite passes for a role RealmID would refuse; their Vitest suite mocks
   the SDK, so it stays green against a failed install. The guide's §9
   ("Testing your integration") should say what a stub must validate to be
   worth anything, and that a typecheck is stronger evidence than a mocked
   suite.

4. **Document that service-account provisioning VALIDATES the role name.**
   `service_accounts.go:281` → `validateRoleForTenantKind` → `400 unknown_role`.
   Undocumented, and it is the difference between "re-provision onto the right
   role" being a recovery path and being a dead end.

5. **Pinning guidance, both ecosystems.** A caret does not cross a 0.x minor —
   `^0.4.3` never installs `0.5.0` and `npm update` is silent about it. And go
   `0.51.0` reports `const Version = "0.50.0"`; pin `0.51.1` if you read
   `realmid.Version`.

6. **A "what changes when RealmID changes" section.** The guide explains the
   surface but never tells a partner which of our changes can reach their
   runtime. Role vocabulary, claim shape and error codes all can; our
   `permissions` arrays cannot. That framing is what a partner needs to know
   which of our release notes to actually read.

Related: the incident write-up is in the umbrella repo
(`PARTNER-HANDOFF-TRAIDE-SDK-UPGRADE-2026-08-31.md`, private), and the method
for handling this class of question is the `partner-integration-support` skill
in the same repo.

## Go middleware

- [ ] **A partner-hook refusal still leaks hook wording into the SPA's error `message`.**
      `go/middleware.go` `respondAuthFail` puts `err.Error()` of the wrapped chain into
      `message` (e.g. "OnIdentityResolved refused the min…"), although code, status and
      Details are correctly `401 server_error` (go/identity_resolved.go:192-194 says a hook
      refusal must not look like the partner's own error). Pre-existing before go v0.66.0;
      found by the v0.66.0 builder 2026-10-12. Fix: a fixed message for non-`*RealmError`
      refusals, plus a test asserting no hook text reaches the body.

## Docs

> **Regrouped 2026-09-18.** This heading held **19 open items and only 3
> were about documentation** — the rest were parity gaps, web-package
> defects and drift-gate holes filed under `## Docs` because it was the
> last heading in the file. A catch-all section at the bottom is where
> items go to stop being read: nothing scanning for "SDK parity work"
> would ever have looked here. They now sit under the heading that
> describes them.

- [ ] `SPEC.md` §X.6 — the Go single-factor example passes `RealmID:` to `realmid.OTPLoginRequest`, which has no such field (`go/auth.go:853-858`: Identifier, Presented, Origin, TenantID); §X.4's request line says `{ realmId, … }` too. Found 2026-10-17 (ADR-116 W0 docs).
- [ ] `docs/partner-integration-guide.md` + `docs/integration-guide.md` — TWO
      partner integration guides now sit side by side (~1600 and ~1700 lines) and
      overlap substantially. The first arrived 2026-08-28 from the private
      `Realm-ID/issuer` repo, where partners could not read it. They are not
      reconciled; `docs/INDEX.md` currently tells the reader which is which and
      that `SPEC.md` wins on conflict, which is a signpost, not a fix. Decide:
      merge, or split cleanly by audience (SDK-shaped vs platform-shaped).
- [ ] `docs/partner-integration-guide.md` — the published copy is REDACTED
      (customer names removed) and the private issuer original is not. There is
      no check that a future edit does not reintroduce a customer name into the
      public copy. A CI grep over the public repo for the partner-name list would
      be cheap, but the list itself is then hand-maintained — see the failure
      class in the global notes before writing one.
- [ ] `java/CHANGELOG.md` — `0.40.0` (the ADR-101 work: `RoleScopes`, and
      `required_mfa_methods` / `can_invite_roles` leaving `RoleObject`) had NO
      per-package heading; `build.gradle.kts` was bumped and only the monorepo
      `CHANGELOG.md` recorded it. `changelog-hygiene.sh maven` would have caught
      it at publish. The `0.40.0` heading now added covers only the predicate
      port, so the ADR-101 java bullets are still missing from that section.
      *(Filed 2026-08-30.)*

## Cross-language parity gaps

- [ ] **ts: the direct-call lock bound does not cancel the issuer call (critic, 2026-10-16).** `HttpClient` takes no `AbortSignal`, so at the 10s bound the per-session lock is released while the issuer call may still be in flight; Go cancels it. A rotation that lands late is still stored, but a waiter can mint on the old token in that window. Thread an `AbortSignal` through `ts/src/http.ts` and the lock path.
- [ ] **go/ts/java: the `token\0` outcome fingerprint can collide with a crafted middleware refresh (critic, 2026-10-16).** A middleware refresh with `tenant_id:"token"` and matching `custom_claims` produces the same fingerprint string; self-session only, ends in a 500 (`ts/src/middleware.ts` `o.mint!`). Prefix the two namespaces so they cannot meet.


- [ ] **`web-admin`'s browser transport keeps a SEPARATE, much smaller error
      taxonomy** — `web/packages/admin/src/transport.ts` holds **33** codes
      against `ts/src/errors.ts`'s **60** (measured 2026-08-24). So the admin
      console normalizes `platform_not_found` and 26 others to their HTTP-status
      fallback, no matter what the typed SDKs do. It is mitigated, not harmless:
      the transport stashes the raw code in `details.server_code`, so the
      information survives where a caller thinks to look for it.
      **Deliberately NOT folded into the 2026-08-24 taxonomy release** — it is a
      separate, older drift with its own release path (a `web-admin` repack plus
      a re-vendor into `ui/`), and fixing it inside a release about something
      else would have hidden it. `scripts/taxonomy-parity.py` does NOT cover
      this file yet; extending it there is the cheap half, and it should be
      done first so the gap is measured rather than re-discovered.

      ✅ **STILL LIVE — re-verified 2026-09-13.** `/usr/bin/grep -c
      platform_not_found` returns **0** in
      `web/packages/admin/src/transport.ts` against **3** in
      `ts/src/errors.ts`. Published as `@realm-id/web-admin` `0.17.0`, so the
      drift is in the package the console actually loads. Severity stays
      low-moderate on the strength of the `details.server_code` mitigation —
      but note that mitigation only helps a caller who already knows to look,
      which is precisely the caller who did not need the typed code.
- [ ] **`not_service` is declared by ts + Java and emitted by NOTHING.** A repo
      sweep of the issuer finds no handler returning it; the only near-match is
      the distinct `role_not_service_typed` (`integration_installations.go:138`).
      It is carried as a reviewed exception in `scripts/taxonomy-parity.py`.
      Removing it is safe in principle — nothing can be matching a code that
      never arrives — but it is a SPEC change across two languages and belongs
      in its own release, not smuggled into one about something else.
      *(Filed 2026-08-24 while registering `platform_not_found`.)*
- [ ] role predicates — go/java expose ONE `isRoleAssignableTo` that folds in
      the system-name and disabled guards; ts splits them into
      `isRoleAssignableTo` (pure server mirror) + `isRoleSeatable` (the picker
      predicate). Three languages, two shapes, and reaching for the wrong one in
      ts offers `owner`. Pick one shape before the SDKs are released together.
      *(Filed 2026-08-30.)*
- [ ] `ts/src/memberships.ts` — `MembershipActionCode`'s nine codes are all
      really emitted (verified 2026-08-30 against `internal/httpapi/`), but they
      are the ONE set `ts/src/roles-drift.test.ts` still cannot compare: the
      issuer declares them inline at ~20 call sites rather than in a single Go
      map, so there is nothing to parse. Either give the issuer a declared
      vocabulary for them or accept the gap knowingly — but it IS a gap, and the
      `platform_mgmt_api` miss is the evidence that an uncovered mirror rots.
      *(Filed 2026-08-30 from W1b.)*
- [ ] `ts/src/roles.ts` — the drift gate compares the SETS the predicates read,
      not the predicate LOGIC: the ADR-091 `is_system` exemption and the ADR-101
      ABSENCE of a per-role MFA floor are asserted by unit tests, so they would
      not go red if the ISSUER changed its mind. `sdk/java`'s gate does parse
      those from the Go source; ts should match. *(Filed 2026-08-30 from W1b.)*

## Web packages (`@realm-id/web*`)

- [ ] `web/packages/core/src/envelope.ts` + `memberships.ts` — `@realm-id/web`
      takes ZERO runtime dependencies, so it cannot import `@realm-id/sdk`,
      which OWNS `unwrapData` / `parseErrorEnvelope` / `MEMBERSHIP_ACTION_CODES`.
      They are held identical by parity TESTS (a devDependency + a shared
      fixture table) rather than by a single source. That is a real gate, not a
      silent copy — but it is still two implementations. Decide deliberately
      whether core should take `@realm-id/sdk` as a runtime dep (it is itself
      dep-free and browser-safe); the cost is the `ui/web` tarball-vendoring
      chain, which pins by filename. *(Filed 2026-08-30 from W2.)*
- [ ] `web/packages/core/src/envelope.ts` — **RE-SCOPED 2026-09-18 after checking
      source; the original framing was wrong.** It read as "two unwrappers that
      should be reconciled". They must NOT be: `envelope.ts:26-28` states in
      terms that *"Both rules are deliberate; do not collapse them"*,
      `transport.ts` matches BFF-SPEC's sole-key rule
      (`web/BFF-SPEC.md:33`), and `envelope.test.ts:90` deliberately PINS the
      divergence. Collapsing them would break the spec and a test written to
      stop exactly that.
      The real residual is smaller and is documentation: **`unwrapData` drops
      envelope SIBLINGS on a paginated body** (`next_cursor`, `has_more`,
      `total` alongside `data`), and that is not said at its call sites — only
      in the function's own doc comment. Name it where it is called, or return
      the siblings. *(Filed 2026-08-30 from W2; re-scoped 2026-09-18.)*
- [ ] `web/packages/admin/` — three `ui/web/src/api.ts` shims were NOT in the
      W2 move list and still have no SDK resource: `fetchPlatformAuditEvents`
      (`GET /platforms/{id}/audit-events`, ADR-055 — distinct from the
      staff-gated `admin.admin.listEvents`), `listTenantUsers` +
      `TenantUserSummary` (`GET /tenants/{id}/users`, the first page only), and
      `selfEnrollMfa` / `verifyMfa` (`/auth/mfa/{enroll,verify}`, which the new
      `withStepUpRetry` drives internally but does not expose). Wave 4 cannot
      empty `api.ts` without them. *(Filed 2026-08-30 from W2.)*
- [ ] `web/packages/admin/src/types.ts` — still hand-declares wire shapes the
      issuer serves (`PlatformNote`, `ApiKeyListItem`, …) with no drift test of
      any kind, which is the same class of defect W2 just removed for
      `ActiveSession`. Audit the file against `issuer/docs/swagger.yaml`.
      *(Filed 2026-08-30 from W2.)*
- [ ] `web/packages/core/src/stepup.ts` — `parseStepUp` hand-reads the 412
      instead of using `parseErrorEnvelope`, which is why it needed its own
      fix for the nested gate payload on 2026-08-30 after the parser already
      had one. `@realm-id/web` cannot import `@realm-id/sdk` (zero runtime
      deps) but it OWNS `parseErrorEnvelope` in the same package — route
      `parseStepUp` through it so there is one reader of that envelope, not two.
      *(Filed 2026-08-30 while settling the error contract.)*

## Drift gates and test infra

- [ ] `ts/src/v063-middleware.test.ts` — "SPEC10_1_4a body mode: loser's 503 carries
      refresh_token" FLAKES under full-suite load: got `200` where it expected `503` once in the
      pre-push `make check` (2026-10-03, failed the go 0.64.2 main push), then passed 6/6 in
      isolation and on the re-push. Its loser/winner ordering is timing-dependent; gate it on an
      explicit barrier, not a sleep, when the held ts v0.63 work resumes.
- [ ] `java/src/test/java/dev/realmid/sdk/roles/RolePredicatesDriftTest.java` —
      the drift gate compares `RolePredicates` against the issuer's own Go
      source, but `Realm-ID/issuer` is a separate private repo that this repo's
      CI never checks out, so the test ABORTS there and only returns a verdict
      on a machine with the workspace checkout. Wire the checkout into
      `ci.yml`'s java job (org-reader GitHub App or a read-only deploy key) and
      make the missing-checkout case a hard failure — a gate that cannot run is
      one release away from being a gate that stopped mattering.
      *(Filed 2026-08-30 with the A1-java predicate port.)*
- [ ] `ts/src/roles-drift.test.ts` — same limit as the Java gate above, and the
      same fix: the half that re-reads the LIVE issuer source cannot run in this
      repo's single-repo CI checkout, so it emits a diagnostic and
      `REALMID_DRIFT_STRICT=1` is what turns "issuer not reachable" into a
      failure. The pinned-snapshot half DOES run everywhere. Wire the issuer
      checkout into `ci.yml` (org-reader GitHub App or read-only deploy key) and
      set `REALMID_DRIFT_STRICT=1` there.
      *(Filed 2026-08-30 with the A1-ts predicate port.)*
- [ ] `go/roles_drift_test.go` — the cross-repo drift check
      (`TestRolePredicatesMatchTheIssuer` and its two siblings) can only run
      where an `issuer/` checkout is a sibling of `sdk/`. In `Realm-ID/sdk`'s
      own CI it finds none, logs `DRIFT CHECK DID NOT RUN` and returns — so the
      only CI that runs the Go suite is the one place the check is inert.
      Either give `.github/workflows/ci.yml` a read-only checkout of
      `Realm-ID/issuer` (see the `cross-repo-deploy-key` pattern) or move the
      comparison to the umbrella repo's cross-repo CI, which already has both
      trees. Until then the guard is a local-session guard. *(Filed 2026-08-30
      from W1a.)*
- [ ] **The `@realm-id/web` ↔ `@realm-id/sdk` parity gate is a LOCAL-SESSION
      guard that reports nothing in CI.** `web/packages/core/src/envelope.test.ts`
      really does run both implementations over a shared fixture table — but
      `.github/workflows/ci.yml` has no job for `web/packages/*` at all, so it
      never runs on a push. It also stayed GREEN through two real divergences on
      2026-08-30 (the nested-sibling sweep and the legacy-message fallback)
      because its FIXTURE TABLE is hand-maintained and carried neither shape;
      five fixtures were added, which fixes those two cases and not the
      mechanism. Two separate gaps, one item: give it a runner, and derive or
      widen the table. (The missing CI job is also the first item in this file,
      filed 2026-08-28 for the same package — this is the second time it has
      cost something.) *(Filed 2026-08-30 while settling the error contract.)*
- [ ] **`ts/tsconfig.json` excludes `**/*.test.ts`, so `npm run typecheck`
      (the CI gate whose whole comment is "catch what tsx's transpile-only
      run can't") never actually checks a test file.** Confirmed by running
      `tsc --noEmit --listFiles` in `ts/` — zero `.test.ts` files in the
      checked set — and separately: even an explicit `tsc … src/*.test.ts`
      invocation fails immediately on `Cannot find module 'node:test'`,
      because this zero-devDep package (by design, matching `sdk/go`) carries
      no `@types/node`. So a `// @ts-expect-error` in a test file (e.g.
      `identity-resolved.test.ts`) documents intent but is not gated by
      anything. `ts/src/tenants.test.ts`'s "decodes status/owner/config typed
      fields" test (finding #6, 2026-09-24) has the same limit — its typed
      local-variable assignments were verified RED/GREEN by hand with an
      isolated `tsc` invocation against `tenants.ts` alone, not by a script
      this repo runs. Fix needs a decision: add a slim
      `@types/node` (test-only devDependency, doesn't touch the shipped
      `dist/`) plus a second `tsconfig.test.json` that includes test files,
      wired into the `ts` CI job. *(Filed 2026-09-24 during the SDK usage
      audit fixes, item #6.)*

## Known contract debt

- [ ] `go/middleware.go` — `MiddlewareOptions.MFAProtectedPaths` is now
      validated by `ValidateMFARules` at wiring time, but an invalid rule only
      LOGS at error level; the middleware still builds. Refusing to construct
      would be the honest behaviour (a rule that cannot fire reads as
      protection and is none), but `Middleware()` has no error return and
      changing that is a breaking signature change for every existing partner.
      Decide it deliberately at the next major. *(Filed 2026-08-30 from W1a.)*


- [ ] `java/src/main/java/dev/realmid/sdk/auth/JwtPeek.java` — THREE private
      unverified-JWT peeks now exist in the Java SDK and none can see the
      others: `tokens/TokensClient.peek` reads `jti`+`exp`,
      `platformtoken/PlatformTokenManager.peekJwtIssuer` reads `iss`, and
      `auth/JwtPeek.subject` reads `sub`. Each was added because the previous
      one was unreachable from the new call site. Consolidate them into one
      package-visible helper (Go has exactly two, `peekJWTUserFields` and
      `peekJWTRevokeFields`, both in one file). Deliberately NOT done inside the
      derived-claims fix — a live-defect fix is the wrong place to move three
      security-adjacent decoders. Any consolidation must keep the "never
      authorize on this" warning attached and must not weaken the malformed-input
      behaviour, which differs per call site today (null vs "" vs null).
      *(Filed 2026-09-01, java `0.44.0`.)*

- [ ] `web/packages/react/package.json`, `web/packages/firebase/package.json`
      — these two browser packages define NO `test` script at all (every other
      web package does). The new `web` CI job (`.github/workflows/ci.yml`) and
      `make check` run `npm test --workspaces --if-present` across
      `web/packages/*`, which silently no-ops on these two rather than
      failing — they are published to npm (`@realm-id/web-react`,
      `@realm-id/web-firebase`) completely ungated by any test. Do not paper
      over this with a placeholder test; write real coverage for each
      package's actual surface (React hooks/context; the Firebase ID-token
      adapter) or explicitly decide "thin enough to skip" and record why.
      *(Filed 2026-09-06, W1-A — sdk/ci.yml gains a `web` job.)*

- [ ] `sdk/.github/workflows/ci.yml` — wire `scripts/contract-parity.py` (+ its
      `scripts/contract-parity.test.py` suite) into CI. It runs today only in
      `make check`/`make self-test`, because it needs a sibling `issuer/`
      checkout (`../issuer/docs/swagger.yaml`) that a plain `actions/checkout`
      on `Realm-ID/sdk` alone does not have — either a composite checkout of
      both repos, or copying the spec file in as a build artifact. Left
      unwired this pass because `ci.yml` had a concurrent, unrelated edit live
      (W1-A's `web` job) and this was not that task.
      *(Filed 2026-09-06, W1-B.)*
- [ ] `sdk/scripts/contract-parity.py` — CONTRACTS covers 5 flat-object
      operations (`integrations.install`/`register`, `auth.listSessions`,
      `roleTemplates.create`, `userApiKeys.create`). Widen it one entry at a
      time; it deliberately does NOT attempt `/auth/login`'s grant-type
      `oneOf` or `RealmConfigPatch`'s nested JSONB knob groups — see the
      script's own header for why forcing those through the hand-rolled
      indentation reader would risk inventing drift rather than finding it.
      *(Filed 2026-09-06, W1-B.)*

## Go SDK only

Items that exist only in `go/`. They live here, not in `go/TODO.md`: a file
under `go/` ships inside the published module zip, so editing it changes the
module hash and demands a version bump (see the note at the top of this file).


- [ ] `go/auth.go` `Token()` — a hop that ends in an error drops the newer rotated refresh token; only the 3-hop give-up returns it. Pre-existing, deliberately unchanged in 0.67.0. ts (`ts/src/auth.ts`) and java (`java/src/main/java/dev/realmid/sdk/auth/AuthClient.java`) have the same shape: check and align all three together.
- [ ] **Go doc comments for `UsersClient.EnrollMFA` / `ConfirmMFA` (`go/tenants.go`) — ship with the NEXT Go release.** Issuer commit 705df35 (next issuer release after v0.134.1) makes both routes SELF-ONLY (`userID` must be the caller, else `403 forbidden`; owner ruling 2026-10-14; an admin uses `ResetMFA`). ts/java/SPEC/guide already say so; the Go comment was left out because editing `go/tenants.go` changes the module hash and `tag-hygiene.sh unreleased-go` demands a `const Version` bump (go/v0.66.0 is tagged). Text: "userID must be the CALLER's own id: from the issuer release after v0.134.1 the route is self-only and answers 403 `forbidden` for any other user; for first-login use AuthClient.SelfEnrollMFA, for another user ResetMFA."

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

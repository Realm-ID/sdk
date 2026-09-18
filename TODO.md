# TODO — sdk/ (go · ts · java · web)

> **Open and actionable only.** Work that is decided-but-not-now lives in
> [`BACKLOG.md`](BACKLOG.md); anything needing an ADR or an owner ruling lives
> in [`OPEN-QUESTIONS.md`](OPEN-QUESTIONS.md); closed and retired records live
> in [`TODO-ARCHIVE.md`](TODO-ARCHIVE.md). An entry belongs here only if
> someone could pick it up today and finish it.

Open work only; shipped items live in `CHANGELOG.md` + `DECISIONS.md`.
`SPEC.md` is law — if a language SDK and the SPEC disagree, fix the SDK.

> ⚠️ **There is a SECOND TODO file in this repo: [`go/TODO.md`](go/TODO.md).**
> It carries Traide-reported Go-specific items (one 🔴) and **nothing
> referenced it** until 2026-09-18 — not this file, not the umbrella `TODO.md`'s
> scope note, not the root `CLAUDE.md` doc map. It was invisible to every sweep,
> which is the worst state for a file holding a 🔴. Check both.

---

> ~~**All three SDKs' `integrations.install()` send the retired `role_id`
> body — a current issuer refuses it.**~~ **CLOSED — the claim is FALSE as of
> 2026-09-13, verified in source here.** `go/integrations.go:85-88` is
> `InstallRequest{IntegrationID, Permissions []string}` with no `RoleID` field
> at all, and `go/integrations_test.go:106` actively asserts `role_id` is
> ABSENT from the body; `ts/src/integrations.ts:49` mentions `role_id` only in
> a comment explaining what replaced it; java's `InstallRequest` likewise names
> `roleId` only in migration doc-comments (`:10,23`). All three speak the
> `permissions` contract. **The fix landed and the entry was never closed** —
> and it is a bad one to leave standing, because it tells a reader the shipped
> SDKs are broken against prod when they are not.
>
> ~~ADR-101 D7 (issuer `v0.113.0`) replaced
> the role-based install with a stated `permissions: []string` grant; the
> issuer's `installReq` has no `role_id` field and an absent/empty
> `permissions` is `400 permissions_required`. `ts/src/integrations.ts:229`
> (`body: { integration_id, role_id }`), `go/integrations.go:76`
> (`InstallRequest.RoleID`), and java's equivalent all still speak the old
> contract, and the error unions still carry `role_not_service_typed` /
> `role_not_installable` / `role_unavailable`, which no current issuer emits.
> Fix in all three + SPEC, with a drift test against the issuer swagger.
> *(Found 2026-08-31 during the docs audit; the docs now describe the issuer
> contract and warn about this lag — `docs/integration-guide.md` §9.2/§9.3,
> `docs/error-reference.md`.)*~~
>
> ⚠️ **Residual worth checking when someone next touches this area** (NOT
> verified in this pass, so it stays a question, not a finding): the entry also
> claimed the error unions still carry `role_not_service_typed` /
> `role_not_installable` / `role_unavailable`, which no current issuer emits.
> The request-body half is definitively fixed; the error-union half was not
> re-checked. Also re-read `docs/integration-guide.md` §9.2/§9.3 and
> `docs/error-reference.md` — they were written to WARN about this lag, so
> those warnings are now themselves stale and will mislead a partner.

- [x] **`StarterRole` union duplicates the issuer's `realmrole.StarterRoles`** —
  **CLOSED BY DELETION 2026-09-18, not by reconciliation.** The duplication is gone
  because the SURFACE is gone: ADR-101 (issuer `v0.113.0`) retired starter roles
  entirely, so `PlatformCreate.starter_roles`, the `StarterRole` union and
  `platforms.seedStarterRoles()` were removed in `web-admin 0.19.0`. The field
  was a hard `400 starter_roles_retired` for any non-empty value and the route
  a `404`. The proposed fix — a `GET /platforms/starter-roles` discovery
  endpoint to drive both from one source — is moot: there is no menu.

- [ ] Remaining partner-facing gaps (lower priority): `GET /me` caller identity;
  tenant domain delete (`DELETE /platforms/{pid}/tenants/{tid}/domains/{domain}`);
  realm origin bind/detach (`POST` / `DELETE /platforms/{id}/origins[/{id}]`).
  Operator/base-realm surfaces (platform create/rename, `/admin/*`
  suspend/rotate/notes) are intentionally out of the partner SDK.
- [ ] **`@realm-id/web` `completeSignIn` should recognize an OIDC *error* return**
  (`?error=&state=`, no `code`) — clean the URL and throw a typed `RealmError`
  instead of returning `null`. Today `ui/web/src/AuthGate.tsx` detects `?error=`
  itself (`humanizeOidcError`) because `readCallback` requires `code`; folding it
  into the SDK removes the app-side special case. Needs a version bump + a
  vendored-tarball re-pin in `ui/web`.

## `@realm-id/web-admin` gaps (the UI carries shims until these land)

Consolidated from `ui/TODO.md` — the UI-side shim locations are tracked there;
this is the SDK-side work.

- [ ] **Email-based ownership transfer.** `admin.tenants.transferOwner` accepts
  only a resolved `ownerUserId`; `OwnershipTransferDialog` needs an email variant
  the BFF resolves server-side. *Cross-check before building:* the ADR-076 handler
  already accepts a `new_owner_email` fallback — this may be a pure type/method
  addition rather than new behavior.
- [ ] **`RolesClient` is realmId-bound at construction.** A per-call `realmId`
  override would help cross-realm ops UIs. Not blocking today — the UI works
  around it with `useAdminForRealm(realmId)`, which returns a realm-scoped cached
  `Admin`.
- [ ] **`bff.home()` / `bff.tenantFull()` return loose `{ [k: string]: unknown }`.**
  Rich types live in `@realm-id/sdk/internal`; the aggregates package types need a
  refresh before the admin SDK can re-export them.

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

## Docs

> **Regrouped 2026-09-18.** This heading held **19 open items and only 3
> were about documentation** — the rest were parity gaps, web-package
> defects and drift-gate holes filed under `## Docs` because it was the
> last heading in the file. A catch-all section at the bottom is where
> items go to stop being read: nothing scanning for "SDK parity work"
> would ever have looked here. They now sit under the heading that
> describes them.

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
- [ ] `ts/src/errors.ts` + `go/errors.go` + `java/.../ErrorCode.java` —
      `membership_not_found` is emitted by the issuer
      (`internal/httpapi/me_memberships.go`, three call sites) and is in NONE of
      the three taxonomies, so it falls back to `not_found` and the specific
      remedy is lost. Adding it to one language alone fails
      `scripts/taxonomy-parity.py`, which is why it was not done with the
      ADR-092 D5 `MembershipActionCode` type — that union carries the code, the
      SDK taxonomy does not. Three-language change. *(Filed 2026-08-30.)*

      ✅ **STILL LIVE — re-verified 2026-09-13, and it is live in the PUBLISHED
      packages, not merely in this tree.** `/usr/bin/grep -c
      membership_not_found` returns **0** for both `ts/src/errors.ts` and
      `go/errors.go` (java the same), while the issuer emits it from
      `internal/httpapi/me_memberships.go:62,116,228`. The shipped versions
      carrying the gap are npm `0.51.0`, Go proxy `go/v0.59.0` and Maven
      `0.48.0` — i.e. every partner integrating today gets the generic
      `not_found` and loses the specific remedy. That makes this the
      highest-value of the SDK items here: it is the only one a partner can hit
      without doing anything unusual.
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
- [x] `web/packages/core/src/types.ts` — **DONE 2026-09-18.** `web/BFF-SPEC.md`
      § `GET /providers` now names `tenantId` (response root) and `nickname`
      (each provider row) as OPTIONAL, in the example AND in a table stating
      what ABSENT means — for `tenantId`, "the server did not resolve one",
      never "no tenant", since a realm-root origin legitimately has none.
      Documentation-shaped, not a code fix: both fields were already typed in
      `@realm-id/web`; the spec a partner BFF author implements from named
      neither. *(Filed 2026-08-30 from W2.)*
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

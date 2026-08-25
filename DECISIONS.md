# Decision Log — Realm ID SDK monorepo

The **why** behind changes to `Realm-ID/sdk` — problem, options weighed,
decision, tradeoffs. Terse "what shipped" lives in `CHANGELOG.md`; the locked
behavioural contract lives in `SPEC.md`. This file is the running index of "why
did this change happen."

Newest first.


## Index

62 entries total — 23 here, 39 in `DECISIONS-ARCHIVE.md` (entries before 2026-07-27). Newest first.

- [2026-08-25 — changelog backfill + the DECISIONS.md index/archive split, re-pointed at the real problem file](#2026-08-25-changelog-backfill-the-decisionsmd-indexarchive-split-re-pointed-at-the-real-problem-file)
- [2026-08-25 (later) — the web-admin suite tested a build artifact, and three mutations proved it](#2026-08-25-later-the-web-admin-suite-tested-a-build-artifact-and-three-mutations-proved-it)
- [2026-08-25 — the host `npm test` was broken by the workaround written to work around it](#2026-08-25-the-host-npm-test-was-broken-by-the-workaround-written-to-work-around-it)
- [2026-08-24 (later) — the taxonomy claim was measured, and it was eight codes wrong](#2026-08-24-later-the-taxonomy-claim-was-measured-and-it-was-eight-codes-wrong)
- [2026-08-24 — the changelog gate derives its subjects, and refuses to check nothing](#2026-08-24-the-changelog-gate-derives-its-subjects-and-refuses-to-check-nothing)
- [2026-08-23 (later still) — SPEC §10.4's "backstop" claim is WITHDRAWN (ADR-096 D3)](#2026-08-23-later-still-spec-104s-backstop-claim-is-withdrawn-adr-096-d3)
- [2026-08-23 (later) — tag hygiene extended to ts/java, and the one check that can actually prevent](#2026-08-23-later-tag-hygiene-extended-to-tsjava-and-the-one-check-that-can-actually-prevent)
- [2026-08-23 — the annotated/immutable tag rule was documented for seven weeks and followed by a coin flip](#2026-08-23-the-annotatedimmutable-tag-rule-was-documented-for-seven-weeks-and-followed-by-a-coin-flip)
- [2026-08-21 (last) — the SDK monorepo had no CI, which is why "add a gofmt gate" was never ten minutes](#2026-08-21-last-the-sdk-monorepo-had-no-ci-which-is-why-add-a-gofmt-gate-was-never-ten-minutes)
- [2026-08-21 (latest) — TS `listSessions` pages, and the break is deliberate](#2026-08-21-latest-ts-listsessions-pages-and-the-break-is-deliberate)
- [2026-08-21 (later still) — the last parity gap was a mode the issuer refuses](#2026-08-21-later-still-the-last-parity-gap-was-a-mode-the-issuer-refuses)
- [2026-08-21 (later) — an SDK E2E suite, and the two defects it found on its first run](#2026-08-21-later-an-sdk-e2e-suite-and-the-two-defects-it-found-on-its-first-run)
- [2026-08-21 — the Java realm pin, and the device label TS never sent](#2026-08-21-the-java-realm-pin-and-the-device-label-ts-never-sent)
- [2026-08-06 — wrap both by-id platform reads; two "blocked on a repack" items were already shipped](#2026-08-06-wrap-both-by-id-platform-reads-two-blocked-on-a-repack-items-were-already-shipped)
- [2026-08-05 — the Go `Version` const drifted a third time; the fix is the check, not the bump](#2026-08-05-the-go-version-const-drifted-a-third-time-the-fix-is-the-check-not-the-bump)
- [2026-08-03 — the browser SDK's `MeMembership` catches up to `/me`, and the changelog catches up to the versions (web-admin `0.8.18`)](#2026-08-03-the-browser-sdks-memembership-catches-up-to-me-and-the-changelog-catches-up-to-the-versions-web-admin-0818)
- [2026-08-03 — `acceptInvitation` ships with the tests the feature commit skipped (go `0.44.0`, ts `0.35.0`, java `0.34.0`)](#2026-08-03-acceptinvitation-ships-with-the-tests-the-feature-commit-skipped-go-0440-ts-0350-java-0340)
- [2026-08-02 — dropping `allowedDomains`: a removed field is safer than a stale one (go `0.43.0`, ts `0.34.0`, java `0.33.0`, web-admin `0.8.17`)](#2026-08-02-dropping-alloweddomains-a-removed-field-is-safer-than-a-stale-one-go-0430-ts-0340-java-0330-web-admin-0817)
- [2026-08-02 — on-behalf-of reaches the typed surface by DERIVING a client (ts `0.33.0`, java `0.32.0`)](#2026-08-02-on-behalf-of-reaches-the-typed-surface-by-deriving-a-client-ts-0330-java-0320)
- [2026-07-30 — ADR-092 surface: a `me` namespace, and the picker is not an error](#2026-07-30-adr-092-surface-a-me-namespace-and-the-picker-is-not-an-error)
- [2026-07-28 — cookie shadowing: read every candidate, and evict the twin](#2026-07-28-cookie-shadowing-read-every-candidate-and-evict-the-twin)
- [2026-07-28 — web-admin 0.8.16: publish permissions, not a marker to expand](#2026-07-28-web-admin-0816-publish-permissions-not-a-marker-to-expand)
- [2026-07-27 — ADR-089's doc debt: the spec still described the refresh step it deleted](#2026-07-27-adr-089s-doc-debt-the-spec-still-described-the-refresh-step-it-deleted)
- [2026-07-26 — the missing `/internal` export: why the UI reimplemented a client we shipped](DECISIONS-ARCHIVE.md#2026-07-26-the-missing-internal-export-why-the-ui-reimplemented-a-client-we-shipped)
- [2026-07-26 — the api-key `label` asymmetry: a known quirk is not the same as a decision](DECISIONS-ARCHIVE.md#2026-07-26-the-api-key-label-asymmetry-a-known-quirk-is-not-the-same-as-a-decision)
- [2026-07-24 — web-admin transport must not relabel client-side auth errors as `network` (0.8.11)](DECISIONS-ARCHIVE.md#2026-07-24-web-admin-transport-must-not-relabel-client-side-auth-errors-as-network-0811)
- [2026-07-23 — cross-realm integrations surface; the mint returns an access token only](DECISIONS-ARCHIVE.md#2026-07-23-cross-realm-integrations-surface-the-mint-returns-an-access-token-only)
- [2026-07-22 — role `assignable_to` + `can_invite_roles` typed into go/ts/java](DECISIONS-ARCHIVE.md#2026-07-22-role-assignable_to-can_invite_roles-typed-into-gotsjava)
- [2026-07-22 — `web-admin` 0.8.9: starter roles (issuer v0.54.0)](DECISIONS-ARCHIVE.md#2026-07-22-web-admin-089-starter-roles-issuer-v0540)
- [2026-07-21 — GET config + GET platform stats typed into go/ts/java](DECISIONS-ARCHIVE.md#2026-07-21-get-config-get-platform-stats-typed-into-gotsjava)
- [2026-07-20 — ADR-080 Phase B + session-revoke + MFA-self typed parity (all 4 SDKs)](DECISIONS-ARCHIVE.md#2026-07-20-adr-080-phase-b-session-revoke-mfa-self-typed-parity-all-4-sdks)
- [2026-07-16 — fix: Java `tenants().create` diverged from the contract (route + body)](DECISIONS-ARCHIVE.md#2026-07-16-fix-java-tenantscreate-diverged-from-the-contract-route-body)
- [2026-07-16 — feat: federation-bindings client in all three SDKs (S-06, ADR-057)](DECISIONS-ARCHIVE.md#2026-07-16-feat-federation-bindings-client-in-all-three-sdks-s-06-adr-057)
- [2026-07-16 — feat: IdP discovery surface ported to TS + Java (S-05, SPEC §6.10)](DECISIONS-ARCHIVE.md#2026-07-16-feat-idp-discovery-surface-ported-to-ts-java-s-05-spec-610)
- [2026-07-16 — feat: list filters (role/status/q on users, status on invitations) across all SDKs (S-07)](DECISIONS-ARCHIVE.md#2026-07-16-feat-list-filters-rolestatusq-on-users-status-on-invitations-across-all-sdks-s-07)
- [2026-07-16 — feat: `users.importUsers` ported to Go + Java (S-03, ADR-073 Release B)](DECISIONS-ARCHIVE.md#2026-07-16-feat-usersimportusers-ported-to-go-java-s-03-adr-073-release-b)
- [2026-07-16 — feat: owner-transfer optional params across all three SDKs (WP6, ADR-076)](DECISIONS-ARCHIVE.md#2026-07-16-feat-owner-transfer-optional-params-across-all-three-sdks-wp6-adr-076)
- [2026-07-16 — feat: Java `tenants.updateUserRole` parity (S-04)](DECISIONS-ARCHIVE.md#2026-07-16-feat-java-tenantsupdateuserrole-parity-s-04)
- [2026-07-15 — fix: TS + Java `auth.login` wire body diverged from the issuer contract (S-01/S-02)](DECISIONS-ARCHIVE.md#2026-07-15-fix-ts-java-authlogin-wire-body-diverged-from-the-issuer-contract-s-01s-02)
- [2026-07-15 — SPEC.md rewritten to current surface (doc sweep)](DECISIONS-ARCHIVE.md#2026-07-15-specmd-rewritten-to-current-surface-doc-sweep)
- [2026-07-15 — ADR-075: role `required_mfa_methods` write surface](DECISIONS-ARCHIVE.md#2026-07-15-adr-075-role-required_mfa_methods-write-surface)
- [2026-07-14 — ADR-074: `roles.listPermissions()` + delete `migrate_to`](DECISIONS-ARCHIVE.md#2026-07-14-adr-074-roleslistpermissions-delete-migrate_to)
- [2026-07-14 — Realign Go `const Version` to the module tag (`go/v0.30.0`)](DECISIONS-ARCHIVE.md#2026-07-14-realign-go-const-version-to-the-module-tag-gov0300)
- [2026-07-14 — ADR-073 Release B: `users.importUsers` (`@realm-id/web-admin` 0.8.3)](DECISIONS-ARCHIVE.md#2026-07-14-adr-073-release-b-usersimportusers-realm-idweb-admin-083)
- [2026-07-14 — ADR-073 Release A: `PlatformCreate.domain` optional (`@realm-id/web-admin` 0.8.2)](DECISIONS-ARCHIVE.md#2026-07-14-adr-073-release-a-platformcreatedomain-optional-realm-idweb-admin-082)
- [2026-07-14 — ADR-071/072 WP8: web-admin service-accounts + sources surface (`@realm-id/web-admin` 0.8.0)](DECISIONS-ARCHIVE.md#2026-07-14-adr-071072-wp8-web-admin-service-accounts-sources-surface-realm-idweb-admin-080)
- [2026-07-14 — ADR-071/072 WP6: ts + java parity port (ts 0.20.0 · java 0.18.0)](DECISIONS-ARCHIVE.md#2026-07-14-adr-071072-wp6-ts-java-parity-port-ts-0200-java-0180)
- [2026-07-14 — ADR-071/072 WP5: service accounts + OTP-login cutover + sources (go reference)](DECISIONS-ARCHIVE.md#2026-07-14-adr-071072-wp5-service-accounts-otp-login-cutover-sources-go-reference)
- [2026-07-13 — roles enable/disable + owner signing-keys client (go/v0.28.0 · ts 0.19.0 · java 0.17.0 · web-admin 0.7.1)](DECISIONS-ARCHIVE.md#2026-07-13-roles-enabledisable-owner-signing-keys-client-gov0280-ts-0190-java-0170-web-admin-071)
- [2026-07-11 — `is_base` on `MeMembership` (`@realm-id/web-admin@0.6.1`)](DECISIONS-ARCHIVE.md#2026-07-11-is_base-on-memembership-realm-idweb-admin061)
- [2026-07-10 — surface `idle_ttl` from login/token/refresh (ADR-070 idle session timeout)](DECISIONS-ARCHIVE.md#2026-07-10-surface-idle_ttl-from-logintokenrefresh-adr-070-idle-session-timeout)
- [2026-07-10 — SPEC §3: document the uniform-200 success/envelope contract (issuer ADR-069)](DECISIONS-ARCHIVE.md#2026-07-10-spec-3-document-the-uniform-200-successenvelope-contract-issuer-adr-069)
- [2026-07-09 — `refresh_exp` on the wire (SPEC §4.1) + drop the dead `Origin.DetachedAt`](DECISIONS-ARCHIVE.md#2026-07-09-refresh_exp-on-the-wire-spec-41-drop-the-dead-origindetachedat)
- [2026-07-08 — `SessionInfo` last-used timestamp reconciled to the issuer's `last_seen_at` field (Go / TS / Java)](DECISIONS-ARCHIVE.md#2026-07-08-sessioninfo-last-used-timestamp-reconciled-to-the-issuers-last_seen_at-field-go-ts-java)
- [2026-07-05 — `@realm-id/web@0.4.5`: `resolveTenant()` — complete a tenant-picker gate without re-running the provider redirect](DECISIONS-ARCHIVE.md#2026-07-05-realm-idweb045-resolvetenant-complete-a-tenant-picker-gate-without-re-running-the-provider-redirect)
- [2026-07-05 — `go/v0.25.0`: retire the deprecated `method` login field on the RIGHT hop (ADR-051)](DECISIONS-ARCHIVE.md#2026-07-05-gov0250-retire-the-deprecated-method-login-field-on-the-right-hop-adr-051)
- [2026-07-05 — `web-bff-realmid@0.3.6`: revert 0.3.5 — the web SDK migration targeted the wrong hop](DECISIONS-ARCHIVE.md#2026-07-05-web-bff-realmid036-revert-035-the-web-sdk-migration-targeted-the-wrong-hop)
- [2026-07-05 — `web-bff-realmid@0.3.5`: migrate login off the deprecated `method` field to `grant_type`](DECISIONS-ARCHIVE.md#2026-07-05-web-bff-realmid035-migrate-login-off-the-deprecated-method-field-to-grant_type)
- [2026-07-05 — `web-bff-realmid@0.3.4`: bump forced by a fix that shipped without a version bump](DECISIONS-ARCHIVE.md#2026-07-05-web-bff-realmid034-bump-forced-by-a-fix-that-shipped-without-a-version-bump)
- [2026-07-04 — Purge partner identifiers + private-repo references from the public SDK repo (working tree + history)](DECISIONS-ARCHIVE.md#2026-07-04-purge-partner-identifiers-private-repo-references-from-the-public-sdk-repo-working-tree-history)
- [2026-07-01 — `restore()` must send the session bearer; tokenless sessions outlive the access-TTL (web/v0.4.4)](DECISIONS-ARCHIVE.md#2026-07-01-restore-must-send-the-session-bearer-tokenless-sessions-outlive-the-access-ttl-webv044)
- [2026-06 — session-limit 412 gate: collect the issuer's nested-error siblings](DECISIONS-ARCHIVE.md#2026-06-session-limit-412-gate-collect-the-issuers-nested-error-siblings)

---

## 2026-08-25 — changelog backfill + the DECISIONS.md index/archive split, re-pointed at the real problem file

**Problem 1.** `ts/CHANGELOG.md` was missing entries for `0.29.0`–`0.35.0`
(seven releases) and `java/CHANGELOG.md` was missing `java-v0.34.0`, both
recorded as open items in `TODO.md` since `scripts/changelog-hygiene.sh`
closed the mechanism that let it happen (2026-08-24) but did not backfill
history.

**Resolved.** All eight entries backfilled from their release commits
(`ffa935c`, `a512679`, `b6c9ad0`, `52f4eb1`, `398c3ef`, `5f44408`, `1b5e1c0`
for ts; `1b5e1c0` for java), cross-checked against the matching entries
already present in `../CHANGELOG.md` — which had the full cross-language
writeup for every one of these releases, so nothing here is invented. The
stale "Gap notice" blockquote in `ts/CHANGELOG.md` is removed with it.

**Problem 2.** `TODO.md` carried an item asking for an index + archive split
on `DECISIONS.md`, last measured at 2,261 lines. Re-measuring before acting
found two things wrong with the item itself: the number had drifted to 2,480,
and — the bigger miss — `issuer/DECISIONS.md` was 11,565 lines / 198 entries
the same day, 4.6× larger, and named in no item anywhere. The filed file was
not the problem file.

**Resolved.** Both files now carry the `decision-log`-skill treatment: a
one-line-per-entry index under the H1 (archived entries link into
`DECISIONS-ARCHIVE.md`), and an archive split by date. `sdk/DECISIONS.md`
→ 1,285 lines main / 1,274 archive lines (22 entries kept, from
2026-08-25 back to 2026-07-27; 39 archived). `issuer/DECISIONS.md` →
3,183 / 8,598 (46 kept back to 2026-08-08; 152 archived). Entries were
**moved, never reworded** — verified two ways per repo: every original `## `
heading present in exactly one of the two post-split files (sorted-list
diff), and every entry's body text byte-identical to the pre-split original.
No entry lost; a link into the old single file still resolves via the index.

**Not changed:** `sdk/TODO.md`'s own item text is corrected in place rather
than closed-and-refiled, per the file's convention (`> ~~...~~` blockquote
carrying what was verified).

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>

## 2026-08-25 (later) — the web-admin suite tested a build artifact, and three mutations proved it

**Found while closing a TODO that turned out to be false.** `sdk/TODO.md` said
`web-admin` needed `scopes.remove` to match `scopes.rename`. It did not:
`web/node_modules/@realm-id/sdk` is a **symlink to `../../../ts`**, so
`web-admin` re-exports the ts `ScopesClient` and `remove` arrived with ts
`0.40.0`. The item was filed from the shape of the `rename` release rather than
from the package — the same "verify the artifact, not the workaround's absence"
lesson this repo has now recorded three times.

**What was genuinely missing was a test.** No test in this package went through
`createAdmin` at all, so a handle that dropped `scopes`, passed the wrong realm
id, or lost the `/api` prefix would have shipped green — and `0.8.20`'s
changelog asserts exactly that wiring.

**Then the new tests failed to fail.** Three deliberate mutations to
`ts/src/scopes.ts` — remove's path repointed at `/rename`, `dry_run` moved from
query to body, `on_empty` dropped — **all left the suite green**. The cause is
the `exports` map: `@realm-id/sdk/internal` resolves to `dist/internal.js`, so
this suite tests a **build artifact**, and nothing kept it current. `dist/` was
hours stale, so the mutations were never in the code under test.

This is `stack.sh test` running against an unrebuilt api image (issuer
`DECISIONS.md`, 2026-08-25) one layer over, in JS. **Fourth instance of the same
family in two days: the guard is fine and the RUNNER reports success for work it
never did.** The recurring tell is that green costs nothing to obtain.

**Decision — `pretest` rebuilds the dependency, rather than a documented "run
`npm run build` in ts first".** A written prerequisite is a hand-maintained
subject list with one entry, and this workspace's standing finding is that those
decay. Verified by re-running the M1 mutation with **no manual build**: 3 red,
exit 1; clean tree green.

Also rejected: pointing `exports` at `src/`. It would make the tests honest and
the PUBLISHED package wrong — consumers get `dist/`, so testing `src/` would
stop testing what ships.

Five tests, each mutation-verified (M1 remove-path → 3 red · M2 dry_run
query→body → 1 · M3 on_empty dropped → 1 · M4 realm-id default → 1 · M5 dry_run
always sent → 4). web-admin 58 pass / 0 fail; the `web` workspace green
throughout.

## 2026-08-25 — the host `npm test` was broken by the workaround written to work around it

**Symptom.** `npm test` in `sdk/ts` failed on the macOS host with *"You installed
esbuild for another platform"* — **0 pass / 30 fail, on a clean HEAD**. The tree
held `@esbuild/linux-arm64` and nothing else, while the lockfile lists every
platform as an optional dependency. Measured 2026-08-24; the suite is 221/0 in
Docker, so a green CI and a red laptop disagreed about the same commit.

**Root cause.** A container `npm ci` ran over the **bind-mounted host tree**, so
the linux binary replaced the darwin one. The tracker recorded this as
compose damage and prescribed *"shadow `node_modules` in compose, as the
2026-07-27 `ui/web` rollup fix did"* — and **that shadow was already in place**:
`tests/docker-compose.test.yml`'s `sdk-e2e-ts` mounts a named volume at
`/work/sdk/ts/node_modules`, and has since `dbeeb75`, the commit that introduced
the service. Its comment names this exact hazard. Compose could not have done it.

What did it is the recipe people reach for **when there is no compose service** —
the one the TODO itself published as the remedy:

    docker run --rm -v "$(pwd)":/w -w /w node:22-alpine npm ci && npm test

That bind-mounts the package with no shadow. **The documented workaround was the
defect**, and the prescribed fix was already shipped, so following the entry
would have produced no change and left the tree broken.

**Reproduced, not argued.** Host `darwin-arm64` → one run of the recipe above →
host `linux-arm64`. Then repaired and re-run under the new script → host stays
`darwin-arm64`, suite 221/0 in the container. Four measurements, both directions.

**Why it wasn't caught.** Nothing observes the host tree. The unit suite runs in
CI on linux, where a linux-only `node_modules` is correct, so the only surface
that can see the breakage is a developer's laptop — and the damage is silent at
write time and only surfaces on the *next* host run, by which point the container
run that caused it is far away. The dating is what closed it: `node_modules` and
`package-lock.json` share an mtime of 2026-08-24 19:11, inside the session that
ran the recipe.

**Fix.** `scripts/npm-in-docker.sh <package-dir> [npm args...]` — bind-mounts the
package, shadows `node_modules` with a per-package named volume, runs `npm ci`
into the shadow, then the requested npm command. The shadow now lives **wherever
an npm command meets a bind mount**, not only in compose, which is the property
that was actually missing. The host tree was reinstalled; `npm test` is 221/0 on
macOS again.

**Prevention.** The script replaces the recipe in `sdk/TODO.md` and
`ts/README.md`, so the written remedy is no longer the cause. It handles
SELF-CONTAINED packages only and **refuses the `web` workspace outright** rather
than half-running it: measured, `web` as a target fails web-admin's pretest with
`ENOENT /ts/package.json` (the sdk symlink points above the mount), then runs the
other three workspaces anyway and exits 254 — a partial run under a non-zero
code, the shape that gets skimmed as "noisy but passing". The web tree needs no
native binaries, so the host is the right place for it. A regression *test*
was considered and rejected: asserting "a container run leaves the host tree
alone" requires a docker-in-test harness to prove a property that is now
structural (there is no unshadowed mount left to exercise), and the guard would
cost more than the class it protects. Stated rather than skipped silently.

## 2026-08-24 (later) — the taxonomy claim was measured, and it was eight codes wrong

**Problem.** `sdk/TODO.md` asked whether `platform_not_found` should join the
`ErrorCode` taxonomy, and argued: *"Consistent across the three SDKs, so no
language is the outlier; that is why it reads as intentional and may be."*

**The premise was false twice over.**

1. **Consistency is not evidence of intent.** The three lists are hand-maintained
   from one SPEC, so a single omission propagates identically to all three.
   Agreement between them is exactly what a shared oversight looks like; it can
   never distinguish a decision from a miss.
2. **They were not consistent.** Measured: Go lacked six codes ts and Java had
   carried since ADR-071/072; ts and Java both lacked `mfa_registration_required`,
   which Go has had since ADR-061. Eight codes, in both directions.

The taxonomy also already held **six** entity-specific `*_not_found` codes, so
the alternative the item offered — "document that platform-scoped 404s normalize
deliberately" — was not a coherent rule either. It would have been an exception
by decree, with nothing for the next `*_not_found` to follow.

**Decision 1 — register it, and close the whole gap rather than the one code.**
Shipping `platform_not_found` "in lockstep" while eight codes stayed out of
lockstep would have been the ceremony without the substance.

**Decision 2 — `not_service` is NOT propagated.** ts and Java declare it; no
issuer handler emits it (the only near-match is the distinct
`role_not_service_typed`). A code with no producer is a phantom, and adding a
third copy spreads one. It is a reviewed exception in the parity gate, carrying
its reason, and removing it from ts/Java is filed rather than smuggled into a
release about something else.

**Decision 3 — accept the break, and name the migration.** A caller matching
`not_found` on a platform route now stops matching. That is behaviour-breaking
even though the change is purely additive to a union, so all three changelogs
say BREAKING and give the remedy — match both, which is already the idiom the
sibling codes use. Zero first-party consumers branch on `not_found` for a
platform route; the exposure is external partners, and the cost of leaving it is
a taxonomy nobody can reason about.

**What registration BROKE, and why the existing test mattered more than the new
ones.** A registered code lands in `RealmError.Code` and is never copied into
the envelope siblings; an unregistered one survives only in the siblings. Go's
`mapServiceAccountErr` and `mapSourceErr` read only the siblings, via
`detailCode` — so the day their codes became canonical they stopped matching,
and stopped **silently**: the call returns a bare `*RealmError` and
`errors.Is(err, ErrSourceNotFound)` goes false at every call site with nothing
logged. `TestServiceAccounts_HandleTakenMapsSentinel` caught it on the first
run. `integrations.go` had already hit this exact thing and fixed it inline with
a comment; that inline fix is now the named, shared `specificCode` helper, so
the next code to be registered does not re-earn the bug.

**Decision 4 — the gate is a separate CI job reading all three languages.** The
drift is invisible from inside any single language's suite, because each list is
individually self-consistent — which is precisely how it survived. The script
also checks Go's `knownCodes` map against Go's own const block (a second
hand-maintained list in one file, where a const that never reaches the map is
registered in name only), and refuses to pass when it parses implausibly few
codes: a regex that quietly stops matching would otherwise report perfect parity
across three empty sets. Five mutations; one found that the ts anchor matched
`ErrorCodeX` as a prefix and kept parsing a renamed union.

**Not done: `web-admin`.** Its browser transport keeps a **separate** 33-code
list against ts's 60, so the admin console still normalizes `platform_not_found`
— and 26 others. That is a bigger, older drift with its own release path
(a repack + re-vendor into `ui/`), and folding it in here would have hidden it
inside a release about something else. Filed.

## 2026-08-24 — the changelog gate derives its subjects, and refuses to check nothing

**Problem.** Three packages independently lost changelog history (`ts`
`0.29.0`–`0.35.0`, `web-admin` `0.8.13`–`0.8.17`, `java` `java-v0.34.0`). Two
TODO items proposed backfilling the entries. Backfilling is the wrong first
move: nothing failed when a release skipped its entry, so the next release skips
again and the backfill is re-earned. The mechanism goes first; the backfills stay
open and can no longer grow.

**Decision 1 — the subject list is the filesystem, never a list in the script.**
`npm` mode globs `web/packages/*` and adds `ts/`. This workspace has been burned
repeatedly by guards whose subject list was hand-maintained (root `TODO.md`, the
2026-08-02 sweep: three findings in one day, every one a check whose subjects
were enumerated by hand). The cost of deriving is that the gate sees packages the
publish workflow does not — which is the point, and is what it found: two
non-private packages, `@realm-id/web-firebase` and `@realm-id/web-google`,
versioned `0.4.0` and **404 on the npm registry across every version**, absent
from the workflow's `for pkg in core react bff-realmid admin` loop.

**Decision 2 — record "not published" in the package, not in the omission.**
Both are marked `"private": true` rather than special-cased in the gate. npm
itself then refuses to publish them, and the fact stops depending on a name
being missing from a `for` loop in a YAML file. They are genuinely superseded:
`realm.signIn(type)` in `@realm-id/web` reads the provider's public config from
`realm.providers()` and needs no adapter package. `web/README.md` had been
telling partners to install exactly one of the two — an `npm i` that 404s — and
its "Release status (2026-06-03)" block still claimed the whole `0.4.0` line was
unreleased. Corrected against the registry, not against the repo.

**Decision 3 — a missing CHANGELOG.md is a failure, not a skip.** Three web
packages had none at all. Treating that as "this package doesn't keep one" is
how fourteen published versions went unrecorded without ever looking wrong. All
three are seeded from their current version, each stating plainly where the
earlier history is (`git log`, and for `bff-realmid` the monorepo changelog's
own `web-bff-realmid/v0.3.x` headings). **Nothing is reconstructed from commit
subjects and presented as a record**, and the `bff-realmid` entries are NOT
copied out of the monorepo file — two copies of one changelog is the mechanism
that lost `web-admin` `0.8.13`–`0.8.17` in the first place.

**Decision 4 — `go` is gated even though its remedy comes late.** The module
publishes by tag push, so the check necessarily runs after release. Unlike the
`Version`-const check, that is acceptable here: prose is not immutable the way a
module hash is, so a red gate means "write the entry", never "re-point the tag".

**What the mutations were worth.** Seven were run; six confirmed the intended
check. The seventh found a defect in the gate itself: with the derivation
returning nothing, `set -u` aborted on the empty array *before* the "inspected 0
packages" guard could run — exit 1 with no diagnosis, in exactly the case that
guard exists for. A zero-subject guard placed after the loop it protects cannot
fire. Moved above it; both empty cases (no directories, all directories private)
now exit 2 with a distinct message.

## 2026-08-23 (later still) — SPEC §10.4's "backstop" claim is WITHDRAWN (ADR-096 D3)

§10.4 said: *"The server's `RequireMFA(pattern, opts)` registry is the backstop
for non-SDK callers."*

Under ADR-096 D2 that is not merely unimplemented, it is **impossible**: the
route→policy map lives in the enforcing backend, RealmID stores no list of a
partner's operations, and **you cannot back-stop a policy you do not hold**.

Corrected rather than left standing, because the sentence is load-bearing in the
wrong direction: the next reader designs against a guarantee that is not there
and ships an unenforced gate. The replacement says what the issuer registry
actually is — the gate for RealmID's OWN auth-surface operations, where RI is
the enforcing party — and points a non-SDK adopter at
`issuer/docs/partner-integration-guide.md` §5.1, which now carries the HTTP-level
contract they need.

No package version moves: this is a SPEC edit with no behavioural change in any
language SDK.

## 2026-08-23 (later) — tag hygiene extended to ts/java, and the one check that can actually prevent

Both residuals filed earlier today were decided by the repo owner and shipped:
`annotated-prepublish` wired into `publish-npm.yml` and `publish-maven.yml`, and
`unreleased-go` wired into the CI Go job.

### ts/java: the ORDERING mattered more than the decision

The filed question was whether to enforce annotation on `ts-v*` / `java-v*` at
all, given npm and Maven Central are immutable by policy so a moved tag costs
provenance rather than correctness. Answer: enforce.

Wiring it exposed something the question had not: **for these two, the check runs
BEFORE anything is published**, because the tag merely triggers a publisher. So a
lightweight tag is still the operator's to fix — delete it, re-cut with `-a`,
push. That is the exact opposite of `go/v*`, where the tag IS the release and the
only remedy is the next patch version.

Printing Go's remedy here would tell an operator to burn a version number for a
tag they could simply recut. Hence a separate `annotated-prepublish` mode whose
sole difference is the remedy it prints, with the caveat that a re-RUN after a
partial publish must not delete the tag. The check is the FIRST step in both
publish jobs so that the "nothing has been released yet" premise it states is
actually true.

### `unreleased-go`: a policy, adopted knowingly

`tag-hygiene.sh unreleased-go` runs on main and every PR: if `const Version` is
`V` and `go/vV` exists and `go/` differs from that tag, it fails and says to bump
the const before merging.

This is the only check in the repo that can prevent rather than report, and it is
aimed at the root shape of the 2026-07-05 incident — a tree changed, the version
did not, and the "fix" was to move the tag. The two tag-time checks cannot help
there: by the time either runs, the tag exists and the proxy may have served it.

**Its cost is a workflow policy and was accepted as one:** after a release, the
first PR touching `go/` goes red until someone bumps the const. That is not a
side effect to apologise for — the skipped bump is the defect. It was filed as a
decision rather than shipped with the earlier work precisely because it changes
how every Go PR merges.

Mutation-verified against the real tree rather than a fixture: declaring the
already-released `0.44.0` makes it fail and print the 12 files that have changed
since that tag. With today's unreleased `0.45.0` it passes, correctly, because
nothing is tagged under it.

`actionlint` and `shellcheck` clean; every mode exercised locally against the
real repository, since Actions is still down.

## 2026-08-23 — the annotated/immutable tag rule was documented for seven weeks and followed by a coin flip

`scripts/tag-hygiene.sh` (annotated + not-re-pointed) wired into
`.github/workflows/verify-go-release.yml` on the `go/v*` tag push, plus the
release procedure in `CLAUDE.md` that keeps it green.

### Why now, and why this item and not a bigger one

Three SDK versions are bumped in-repo and unreleased — go `0.45.0`, ts `0.37.0`
(BREAKING), java `0.35.0`. GitHub Actions has been dead org-wide since
2026-08-20 (re-probed today: run `32650232345`, `startup_failure` at 1s), so the
first thing that will happen when it returns is a tag push. The tag that must
not be wrong is the *next* one, which is the only window in which this work has
any value at all.

### The measurement is the finding

Root `TODO.md` § *Tag hygiene* has said since 2026-07-05 that `go/v*` tags are
annotated and immutable. Counting the tree:

| family | annotated | lightweight |
|---|---|---|
| `go/v*` | 19 | **22** |
| `ts-v*` | 10 | 15 |
| `java-v*` | 10 | 14 |
| `web-v*` | 3 | 2 |

The most recent three Go releases — `0.42.0`, `0.43.0`, `0.44.0` — are all
lightweight, as is `go/v0.21.0`, the tag whose re-pointing caused the checksum
incident this rule was written in response to (2026-07-05). A rule carried by
prose alone was obeyed slightly *less* than half the time, and its own
counterexample sat at the top of `git tag --list`.

### What each check actually detects

**Annotated** is a one-line `git cat-file -t`: an annotated tag resolves to a
`tag` object, a lightweight one to the commit. That difference is the whole
question of whether a tagger, a date and a message exist to be moved.

**Immutable** is the one that needed a mechanism. `sum.golang.org` is an
append-only signed log, so if it already holds a hash for `vX.Y.Z`, that hash is
the permanent public truth about that version; the check re-hashes the tree the
tag points at *now* and compares. A mismatch is not a warning, it is the
statement that every consumer with the old hash in `go.sum` is already broken —
the `go/v0.21.0` incident, live.

`GOMODCACHE` is a fresh directory per run, deliberately. A warm cache can still
hold the pre-re-point zip for the same version, and comparing that against the
sumdb agrees for the wrong reason — a false PASS on the single input the check
exists to catch.

### It is a script, not a `run:` block, because of how it had to be verified

Actions is down and a tag-push workflow is only exercisable by pushing a tag —
the one action whose consequences are irreversible here. Putting the logic in
`scripts/tag-hygiene.sh` made all four outcomes testable on this laptop against
the real repository and the real checksum DB: annotated (`go/v0.41.0`) passes,
lightweight (`go/v0.44.0`) fails 1, an unpublished version short-circuits before
downloading anything, and a published-and-unchanged one passes. The mismatch
branch was mutation-verified by hashing `v0.43.0`'s tree against `v0.44.0`'s
recorded hash — it fails 1 and prints both. `actionlint` and `shellcheck` clean.

### Ordering: a gate with no remedy has to ship with the instruction that avoids it

Both checks run *after* the tag exists, so neither can prevent anything; their
message says "ship the next patch version" and never "fix the tag", because
re-pointing is the harm, not the repair. That makes the documentation half
load-bearing rather than decorative: there was **no written release procedure
for the Go SDK anywhere in this repo** — the only trace was this file's own
prose noting that a release is "otherwise entirely `git tag && git push`", which
is precisely the lightweight form the gate now rejects. `CLAUDE.md` now carries
`git tag -a`. Without that, the next releaser follows the repo and trips an
irreversible gate.

### Skipped on `workflow_dispatch`, on purpose

Dispatched, this workflow resolves the newest existing tag — which is
lightweight today and can never be anything else. A gate that is permanently red
over an uncorrectable historical fact is one people learn to scroll past, and it
would have taken the const check, which *is* dispatchable for a reason, down
with it. The two hygiene steps run on the tag push only; the const check keeps
both triggers.

### Scoped to `go/v*` only

`ts-v*` and `java-v*` tags are lightweight at a similar rate, and it does not
have the same consequence: npm refuses to publish over a version (the workflow
already treats that as a skip) and Maven Central is immutable by policy, so the
artifact cannot be silently replaced by moving a tag. What is lost there is
provenance, not correctness. Enforcing it would mean a red publish over a
cosmetic property — filed in `TODO.md` rather than decided by whoever happened to
be writing this workflow.

### Not done, and it is the half that could actually prevent

A check on `main` — "the declared version already has a tag, and `go/` has
changed since it" — would catch the content-change-under-a-released-version
shape *before* any tag exists, which is the real root of the 2026-07-05
incident. It is not shipped because it imposes a real policy: every PR touching
`go/` after a release would have to bump the version or go red. That is a
workflow decision for the repo owner, not a side effect of closing a CI item.
Filed in `TODO.md`.

## 2026-08-21 (last) — the SDK monorepo had no CI, which is why "add a gofmt gate" was never ten minutes

New `.github/workflows/ci.yml`: go (gofmt, build, vet, test), ts (tsc, node
--test), java (gradle test), on push and PR.

### The gofmt item was ranked at its cheap half and blocked at its expensive one

`TODO.md` carried "`gofmt -l` reports two files", deferring the gate to "the
issuer has a matching open item". That issuer item had been re-noticed three
times — 2026-07-28, 2026-08-05, and again here — each time formatting whatever
had drifted and each time recording that the gate is the real work. It never got
built, and the reason is not that anyone was lazy: **there was no CI in this repo
to add a step to.** The only workflows were `publish-npm.yml`, `publish-maven.yml`
and `verify-go-release.yml`, all tag-triggered.

An item that names a step inside a workflow that does not exist reads as ten
minutes and is not. In the issuer it genuinely was ten minutes; the two were
written as one shared item, so it was ranked at the cheap end and blocked at the
expensive end. **Rank the halves, not the item** — the same lesson the 2026-08-10
issuer pass recorded about the ADR-080 claim table, paying out a second time.

### The larger finding, which nobody had filed

The Go, TypeScript and Java suites — 203 TS tests alone — ran **only when a human
ran them**. A red suite would first have been noticed by a PUBLISH, which is the
worst possible moment: a Go tag is immutable once proxy.golang.org has served it
(`go/v0.21.0` was re-pointed once and downstream `go.sum` verification broke), and
npm is no kinder. This is the "guards that report nothing" class — a green check
means nothing if nothing runs it — except here there was no check at all, only
suites nobody had wired.

### Choices inside the workflow

- **Jobs are independent, not stages.** A broken Java toolchain must not hide a
  red TypeScript suite. Same reasoning as the `if: always()` between the issuer's
  two harness steps.
- **The gofmt step prints the files before failing.** Every previous repair of
  this drift produced a hand-written list of filenames in a TODO, and every
  re-check found the NAMED files clean while DIFFERENT files had drifted —
  including this pass, where the entry named two files and there were four.
  `gofmt -l` derives the list from the tree; the log has to show it, or the next
  reader writes the list down again.
- **Typecheck runs BEFORE the TS suite.** `node --test` goes through `tsx`, which
  transpiles per file WITHOUT typechecking, so a type error never fails a test
  run — exactly how two `TS2345`s sat on `tests/ui-e2e` main until 2026-08-20.
- **`--no-daemon` on gradle.** A CI runner is single-shot, so the daemon buys
  nothing, and stale-output flakes have bitten this workspace before.

### Verification, and its honest limit

`actionlint` clean on both files. Both gofmt gates mutation-verified by appending
a deliberately misformatted function — each fails and names the file. Every job's
command set was run locally in containers (go build/vet/test, `npm ci` +
typecheck + 203 tests, `./gradlew test --no-daemon` → BUILD SUCCESSFUL).

**What is NOT verified: the workflows have never run on GitHub.** Actions has
been dead org-wide since 2026-08-20 (every run `startup_failure` at 0s, billing).
Trigger syntax, action versions and runner behaviour are unproven until the first
real run. Say that rather than implying a green tick exists.

## 2026-08-21 (latest) — TS `listSessions` pages, and the break is deliberate

`AuthClient.listSessions` now returns `Paginated<SessionInfo>` and follows
`next_cursor`. Through `0.36.0` it resolved to `Promise<SessionInfo[]>` holding
the FIRST PAGE ONLY (server default 50). Lands in the unpublished `0.37.0`,
marked BREAKING; SPEC §4.6 updated, since that section documented the divergence
as a standing carve-out.

### Why this list, and not "one more paging TODO"

Silent truncation is bad everywhere; it is sharper here. `listSessions` is what
"sign out everywhere" and "revoke that device" are built on — the controls
someone reaches for when they believe they are compromised. A session missing
from the list is a session they cannot act on, and nothing in the response says
rows were withheld. This is the same reasoning that made issuer `v0.86.0` a
security fix rather than a tidy-up.

### The break was chosen, and the alternatives were real

Three options, all workable:

1. **`Paginated<SessionInfo>`** — breaking, parity-exact.
2. **Keep the array, loop internally to fetch every page** — non-breaking, fixes
   the truncation, but unbounded in requests and memory with no way for a caller
   to stop early, and TS stays shaped unlike both siblings, so SPEC §7's
   cross-language pagination contract keeps a TS carve-out.
3. **Add `listSessionsPaged()` alongside** — nothing breaks, but the truncating
   method stays the one everybody reaches for, so the bug remains the
   out-of-the-box behaviour, and the SDK carries two methods for one endpoint.

(1) was chosen (user call). **The deciding argument was internal consistency,
not cross-language tidiness**: `Paginated<T>` is already exported TS public API
and already what `federationBindings.list()` returns, so the bare array was the
odd one out *inside the TS SDK itself*. It is also the exact counterpart of
Java's `Paginated<Session>`; Go's `iter.Seq2` is the same idea in Go's idiom.

The break is worth naming honestly: a partner on the published `0.36.0` gets a
compile error. That is the POINT — a loud break with an obvious fix beats the
same call quietly returning a different number of rows, which is the failure
mode (2) would have shipped.

### The legacy tolerance is kept, and cannot spin the iterator

`readSessionPage` normalises the flat `{sessions: […]}` and bare-array bodies
before delegating to `readPage`, so SPEC §7's validation still applies to the
envelope a real server sends while partner mocks keep working. Neither legacy
shape carries a cursor, so such a server yields one page and stops — a
pre-envelope mock cannot put a caller in an endless loop. That is asserted, not
assumed: the legacy test now drains through the ITERATOR rather than `page()`.

### Verified against the real issuer, not only a fixture

The unit test proves the SDK follows a cursor its own fixture hands it. It
cannot prove the issuer emits one — and "the fixture agreed with the client
while both disagreed with the server" is exactly how the `{sessions: […]}`
decode survived, in this same method, four days ago. So `tests/sdk-e2e` gained a
case driving the issuer's own `pagedSlice` with `limit: 1`, so two sessions
force a second page and the test costs two logins rather than fifty-one. It
asserts as a PRECONDITION that the server emits `next_cursor` at all; without
that, a server returning everything on page one would satisfy the drain
assertion vacuously.

Mutation-verified three ways: dropping `next_cursor` from the page reader fails
both unit tests AND the e2e case (at the precondition); omitting the cursor from
follow-up requests fails the unit cursor assertion. ts unit 203 pass / 0 fail,
`tsc --noEmit` clean, sdk-e2e ts 8 pass / 0 fail.

### Also fixed, same lines

`docs/integration-guide.md` §4.5 was wrong twice over: it showed the old array
call AND read `s.createdAt` / `s.lastUsedAt`, which TS has never returned — it
hands back the parsed server JSON unmapped, so the fields are `created_at` and
`last_seen_at`. A snippet that cannot run is worse than no snippet; it was the
first thing a partner building a sessions UI would copy.

## 2026-08-21 (later still) — the last parity gap was a mode the issuer refuses

`TODO.md` § *Cross-language parity gaps* carried one entry after the realm pin
and the device label: add the `userId` + `X-On-Behalf-Of-User` BFF path to TS,
"because Go and Java support it". **It is closed by measurement, and the item
was pointing at the wrong SDK.**

**What the live issuer says** (`tests/sdk-e2e`, 2026-08-21):

| call | result |
|---|---|
| platform bearer + bare `X-On-Behalf-Of-User` | `401 x_user_token_required` |
| platform bearer + `X-User-Token`, no id at all | `200` |

Issuer v0.66.0 removed the id-as-identity mode — it was an unauthenticated user
id that any holder of a realm's platform key could use to act as any user in
that realm — and `derivePlatformActsOnUser` now refuses it explicitly rather
than demoting it to the bearer's own authority.

**So TS was never missing the working mode.** `realm.withUserToken(jwt)` has
sent exactly the shape the issuer accepts since ts `0.33.0`. Building the item
as written would have added a mode that 401s — "documented, wired, does
nothing", the shape this workspace has now paid for repeatedly. **Checking the
premise cost one probe against a stack that was already up; building it would
have cost a release.**

**The real defect was on the side the item cited as correct.** Go's and Java's
`UserID` path sends the id with no user token at all, so BFF mode there has been
dead against any issuer since v0.66.0 unless the caller separately threads a
token (Go: `WithUserToken(ctx, …)`; Java/TS: the derived `withUserToken` handle).
Both now refuse locally with an error naming the remedy, rather than issuing a
request that cannot succeed — the server's `401` cannot say which SDK call site
forgot the token, and this can.

**The refusal is SCOPED, and the scoping is the part worth remembering.** The
same header means two different things on the issuer: an IDENTITY pivot on the
sessions and MFA-self routes (`derivePlatformActsOnUser`), and a DOMAIN
PARAMETER on the OTP routes — the OTP subject, read straight off the header,
which `internal/httpapi/otp.go` marks "NOT an authz pivot". A blanket refusal in
Go's shared `resolveOnBehalfOf` broke three OTP tests; the helper now takes an
`idAssertsIdentity` flag and OTP passes false. **A header's name is not its
meaning** — the same bytes were an assertion on one route and an argument on
another.

**Nine tests were pinning the dead mode** (7 Go, 2 Java): they asserted a bare
on-behalf-of id against a fake server that accepts any header, so they passed
throughout the two years the issuer would have refused them. Updated to thread a
user token. Same shape as every other finding in this log where the guard tested
the half that was not broken — and another argument for the E2E suite, which is
where the truth came from.

## 2026-08-21 (later) — an SDK E2E suite, and the two defects it found on its first run

`tests/sdk-e2e/` drives the TS and Java clients against a real issuer on the
compose network. Homed in the umbrella per the ADR-053 SUT-span rule (the SUT
spans sdk + issuer), sharing the existing harness rather than forking one.

**Why it was worth building at all, stated as the finding rather than the
intent.** The unit suites assert what the SDK SENDS, against a fake server the
same suite owns. Nothing in that loop can observe what the ISSUER does, and the
first run turned up two defects that had survived every unit test, both of the
same shape: **the fixture agreed with the client, and both disagreed with the
server.**

**1. `listSessions` returned `[]` against every real issuer (TS).** It read
`raw.sessions`; the issuer answers the LOCKED paged envelope
`{items, next_cursor, total}` (`httpapi.pagedSlice`). Go has read `items` — with
`sessions` as an explicit legacy fallback — the whole time, so this was TS
holding the fallback and not the actual contract. A TS consumer's "your active
sessions" screen was empty and indistinguishable from having no sessions; the
`device_name` field we shipped hours earlier would have rendered nowhere.

The unit test could not have caught it: its fixture served `{sessions: [...]}`,
a shape no issuer emits. **A fixture is a claim about the wire, and an invented
one measures nothing.** Fixed by reading `items` first, keeping `sessions` as a
documented legacy/mock fallback (mirroring Go), re-pointing the fixture at the
real envelope, and moving the legacy case into its OWN test — so the primary
assertion now rests on the shape the server actually sends.

Left open and filed: TS returns the FIRST PAGE only, where Go iterates
`next_cursor`. Real, but a different bug from this one, and conflating them
would have hidden the envelope fix inside a pagination change.

**2. A device label containing a control character never reached the server —
in ANY SDK.** "Send the value raw; the server sanitizes" is the rule we wrote
into three SDKs and the SPEC that same morning. It is wrong for exactly the
input sanitizing exists for: undici throws `Headers.append: … is an invalid
header value` and Go's `net/http` returns `invalid header field value`
(**measured in a container, not inferred**), so the login failed outright with
an error naming the NETWORK rather than the argument.

The fix splits the rule where the responsibility actually splits. The SDK strips
what an HTTP field value cannot carry — C0 controls and DEL — because that is a
TRANSPORT constraint the client must satisfy to make any request at all. The
**120-character cap stays server-side**, because that is a POLICY and a
client-side copy drifts the day either end changes. The stripped value is
byte-identical to what `sanitizeDeviceName` would have stored, so the split
costs nothing observable.

Fixed in all three languages, Go included — it had shipped this hole since
ADR-062 and nothing had ever sent it a control character. An empty result after
stripping sends NO header, because the issuer reads a present empty value as a
supplied label.

**What the E2E is allowed to assume is itself the design.** Each case has a
positive control or a companion negative, and the suite is mutation-verified
end to end: reverting the `listSessions` decode fails 3 TS cases, un-sending the
header fails 3 Java cases, and un-wiring the realm pin from `Realm.builder()`
fails exactly the pin case — the same mutation that four SDK-level unit tests
sail through. The pin case is also the only place anything checks that the
issuer's `iss` is really shaped `<base>/<realmId>` (ADR-020); a unit test mints
its own `iss` and is blind to both failure modes it could have.

**The Java half compiles against the SOURCE tree** (`includeBuild` with an
explicit `dependencySubstitution`), not a published artifact. With releases
blocked, the source is the only thing that changes, and a version coordinate
would have quietly tested what Maven Central last served.

**Incident worth recording, because it inverts a claim made in this file
hours earlier:** the Java SDK's `--offline` builds were passing on stale build
outputs. `jackson-databind:2.17.2` was never in the host Gradle cache; a `clean`
exposed it, and the "195 tests, 0 failures, offline" runs earlier today had been
skipping `compileJava` as UP-TO-DATE. The tests themselves were real and did
run — but "it builds offline" was not true, and is now, since the fetch
populated the cache. **An offline build proves nothing until it has survived a
clean.**

## 2026-08-21 — the Java realm pin, and the device label TS never sent

Two `TODO.md` § *Cross-language parity gaps* entries, closed together because
both are "one language disagrees with the other two about a rule that is
already written down". Java `0.35.0`, TS `0.37.0`. **Neither is released** —
Actions is down on the org, so the bumps sit in the repo unpublished.

**Why parity gaps are worth closing at all.** A rule three SDKs are supposed to
enforce, enforced by two, is worse than one enforced by none: the SPEC says the
check exists, so nobody looks for it, and the language that skips it is the one
where a partner is least likely to notice. `realm_mismatch` had been in Java's
`ErrorCode` since the taxonomy pass — a constant that made the taxonomy look
complete while the check behind it did not exist.

**The pin refuses on mismatch and stays silent on undecodable.** The tempting
"stricter" reading — an access token whose payload we cannot decode is
suspicious, refuse it — is wrong, and the mutation run measured how wrong:
130+ tests across the Java suite go red, because every fixture mints an opaque
`pt-…`, and so would any consumer whose issuer or mock returns a non-JWT
access token. The pin answers *which realm is this token for*; an unreadable
answer is not a wrong answer, and validating tokens is `Verifier`'s job. Go and
TS had both already made this call (Go returns nil on a malformed payload; TS's
peek returns `""` → skip), so matching them is also the interop-safe choice.

**The constructor was kept, not replaced.** `PlatformTokenManager`'s 7-arg
constructor stays and skips the pin, mirroring TS's `if (!realmId) return`. A
manager with no realm to pin against has nothing to compare, and turning that
into a hard failure would break direct constructor users for a check they never
asked for. `Realm.builder()` — how every partner actually builds the SDK —
passes the realm id, so the default is pinned.

**The wiring test is the one that matters, and the mutation proves it.** Four
manager-level tests pass with `Realm` handing the manager `null` for the realm
id: the check is present, correct, and dead for every real consumer. That is
the exact shape this workspace has shipped repeatedly (v0.88.0's correlation
subject side, v0.90.0's `/me` fallback, v0.83.0's console-level invitation
accept) — a guard that is right one layer below where it has to fire.
`RealmPinWiringTest` builds through the public builder and is the only test
that dies under that mutation. Its second case is a positive control, so it
cannot pass by refusing everything.

**The device-name item's own description was false, and in the direction that
hides work.** It read "JAVA ONLY now — `ts/` has it". TS had the READ half
(`SessionInfo.device_name`) and no send half at all: no `deviceName` on
`LoginRequest`, no `X-Device-Name` anywhere in `ts/src`. So a TS consumer could
render a device label with no way to set one, and the entry's own evidence —
the field being present — is what made it look done. Tenth confirmed case in
two weeks of a TODO description outliving its facts; the reusable rule is the
one this very item already carried in its other half: **check the artifact the
consumer gets, not the presence of something nearby.**

**Header, not body, and only on the user grant.** The issuer reads
`X-Device-Name` on `POST /auth/login` (swagger, `maxLength: 120`) and sanitizes
it server-side (`sanitizeDeviceName` strips control characters and caps the
length), so no SDK duplicates that — a client-side cap would silently disagree
with the server's the day either changes. The platform bootstrap that precedes
every user login is an M2M mint the issuer records no device for; sending the
operator's hostname there would leak it onto a credential session for nothing,
so both SDKs assert its absence. Absent means **no header**, not an empty one:
the issuer treats a present empty value as a supplied label.

**Java's session-list fixture had been serving `device_name` since the test was
written** and asserting nothing about it, because `Session` had no such
component and `@JsonIgnoreProperties(ignoreUnknown = true)` swallowed it in
silence. A fixture that carries a field is not coverage of that field.

Every new guard was mutation-verified (8 mutations: pin not called, comparison
inverted, undecodable-treated-as-mismatch, realm id not wired, header
unconditional, header never sent — in both languages, `Session` component
renamed). Java 195 tests / 0 failures; TS 197 / 0 with `tsc --noEmit` clean.

## 2026-08-06 — wrap both by-id platform reads; two "blocked on a repack" items were already shipped

Issuer `v0.87.0` added `GET /platforms/{id}` (owner) and
`GET /admin/platforms/{id}` (base-realm staff). Three TODO items across two
repos wanted them wrapped. Shipped `@realm-id/sdk` `0.36.0`
(`AdminClient.getPlatform`) and `@realm-id/web-admin` `0.8.19`
(`PlatformsClient.get`).

**Why two wrappers and not one.** They are different endpoints with different
audiences and different row shapes — swagger keeps `PlatformSummary` and
`AdminPlatformSummary` distinct and carries an explicit "do not re-merge them"
note, because both were once called `PlatformSummary` and the ops row silently
won every `$ref` under YAML last-key-wins, mis-documenting two partner
endpoints. The staff read stays out of the partner SDK per the standing
`/admin/*` rule.

**The staff wrapper is a correctness fix, not a convenience.** The console was
paging `listPlatforms({limit:100})` up to 20 times and matching client-side, so
the scan was capped at 2000 rows and a platform past that point was reported as
**not found although it exists** — a false negative no retry would clear, and
one that arrives on its own as the fleet grows.

**Correction, recorded because it was asserted before it was checked.**
`ui/TODO.md` described this as rendering "the raw UUID as the platform name with
empty KPI tiles and **no error**", and that description was carried into the
first draft of this entry, the `0.36.0` changelog and the commit message. It is
**wrong**: the screen has always had a `loaded && !summary && !loadErr` branch
rendering a "Platform not found" EmptyState, and the UUID in the header is
deliberate — its own copy says "The header still lets you act on it by id", so
Suspend and Rotate stay usable when the row cannot be read. The bug was a false
negative, not a silent one. It was caught by writing a test that asserted the
UUID must not appear and watching it fail against the actual component.
The lesson is narrow and worth keeping: **a TODO's description of a defect is a
claim about code, not a fact** — this one had been re-copied across two repos.

**Both wrappers must preserve an identical 404.** A platform the caller cannot
see returns the same `platform_not_found` as an id that was never issued —
never `403`. A wrapper that re-labels it (or a consumer that renders "you don't
have access to this platform") reconstructs the enumeration oracle the
identical 404 exists to close. Recorded in both changelogs and in the JSDoc,
because this is the kind of property a well-meaning "better error message" PR
removes.

**Rejected: adding `platform_not_found` to the `ErrorCode` taxonomy.** The
first draft of the 404 test asserted that code and failed — it is absent from
the TS union, and from Go's and Java's too, so a 404 normalizes to `not_found`.
Adding it is a lockstep SPEC change across three languages, and it is
behaviour-breaking despite being additive to a union: every consumer currently
catching `not_found` on a platform route would silently stop matching. Filed in
`TODO.md` as a decision to take deliberately rather than as a side effect of a
wrapper release. The test now asserts the real contract (`not_found` +
`httpStatus: 404` + explicitly not `forbidden`/`unauthorized`), which pins the
security property without over-specifying the code.

**The finding worth keeping: two items were closed by CHECKING, not by
building.** `sdk/TODO.md` recorded `ActiveSession.device_name` and
`RoleObject.assignable_to`/`can_invite_roles` as still-owed and blocked on one
repack, re-verified three times across eight repacks. Both were **already in
the published `0.8.18` tarball**. The re-verifications kept asking whether the
UI still carried its shim — it did — but *a shim that has outlived its need
looks exactly like a shim still needed*. Nobody asked the question that settles
it: is the field in the tarball? `tar -xzOf …tgz package/dist/types.d.ts`
answered it in seconds.

The ADR-081 entry compounded this with a correct grep supporting a false
conclusion: "0 matches for `assignable_to` in `web/packages/admin/src`" is true
and proves nothing, because web-admin **re-exports** `RoleObject` from
`@realm-id/sdk/internal`, so the field was never expected to appear there.

**So the real defect was never the missing fields — it was the shims.**
`ui/web` carried a `SessionRow = ActiveSession & { device_name?: string }`
augmentation and five `r as AssignableRoleLike` casts over values already typed
`RoleObject`. A structural `as` over an SDK type silences precisely the drift
the type exists to report: had the fields genuinely never arrived, those casts
would have gone on passing. Deleted rather than widened — same call as the
`MeMembership` mirror in `0.8.18`. `tsc` passing afterwards is a real check,
not a vacuous one, because the component reads `device_name` at two sites.

**Verification method, stated so it is reusable:** check the packed artifact,
not the source, and not the presence of a workaround.

## 2026-08-05 — the Go `Version` const drifted a third time; the fix is the check, not the bump

`go/realmid.go` declared `Version = "0.38.0"` while the newest published tag was
`go/v0.44.0` — six releases stale, and **live**.

**RCA**

**Symptom** — anyone reading `realmid.Version` got `0.38.0` from a module
resolved at `0.44.0`. Nothing failed; the wrong number was simply reported as
fact. It matters now in a way it did not before: `docs/integrator-sdk-pins.md`
(Realm-ID/project, shipped 2026-08-03) asks partners to report this exact
number back to us as their pin, and that register is what we diff against the
ADR-089 hard floors to decide whether a breaking issuer change is safe to ship.
A wrong const becomes a wrong row in the register built to prevent the Traide
outage.

**Root cause** — the const has **no in-module consumers**. Nothing reads it, so
nothing can fail when it is wrong, so the only thing standing between it and
drift was a human remembering to edit one line during a release that is
otherwise entirely `git tag && git push`. The Go SDK publishes by tag push
alone — the module proxy serves the tag directly, with no release script in
between — so there was never a place where the release *could* have checked.

**Why it wasn't caught** — it was caught, twice, and the prevention chosen both
times was a comment. `go/v0.29.0` shipped reading `0.20.0` and misled a partner
into thinking the ADR-071/072 service-account surface was unreleased; the fix
added a doc comment saying the const MUST be kept in lockstep. `go/v0.35.0`
shipped reading `0.34.0`; the fix extended the comment. The comment grew to 31
lines of accreted per-release narrative, which is the second half of the
mechanism: a declaration wearing that much prose *looks* maintained, so the
stale value underneath reads as deliberate.

**Fix** — two parts, and the order matters.
1. `.github/workflows/verify-go-release.yml` asserts `const Version` equals the
   pushed `go/v*` tag, and can be dispatched to check the newest existing tag at
   any time. This is the actual fix: it is the first prevention that can fail.
2. The const is set to `0.44.0` and its comment cut to the rule plus a pointer
   at the check. Per-release history moved to where it belongs (`CHANGELOG.md`).
   Bumping alone was explicitly rejected — it leaves the same mechanism that
   rotted three times and would have made the fourth drift look like the first.

**Prevention** — the workflow above. Verified by mutation: the extraction is
anchored to `^const Version = "` (so a mention in a comment or a test cannot
satisfy it), it requires exactly one matching declaration, and fed the old
`0.38.0` it rejects against tag `0.44.0`.

**Tradeoff, stated rather than solved:** the check fires at TAG time, which is
after the release exists. It cannot prevent a bad publish, only make it loud —
and because tags are immutable once `proxy.golang.org` has cached them (root
`TODO.md` § Tag hygiene, `go/v0.21.0`), the remedy when it goes red is the next
patch version, never a re-pointed tag. The workflow says so in its failure
output. An earlier check is possible only by giving the const a real consumer —
e.g. sending it as a `User-Agent` — which is a wire change and a separate
decision, so it is not made here.

## 2026-08-03 — the browser SDK's `MeMembership` catches up to `/me`, and the changelog catches up to the versions (web-admin `0.8.18`)

Issuer `v0.83.0` added `invitation_pending` to `/me` and the BFF passed it
through, but `@realm-id/web-admin`'s `MeMembership` never declared it. Nothing
was broken: `ui/web`'s `AccountOrganizations.tsx` declared a local mirror of the
four fields it reads and got the behaviour right. **The mirror is the finding.**

It could only exist because of a cast — `auth.profile?.memberships as
Membership[]` — asserting a `MeMembership[]` into a wider local shape. That
assertion silenced the compiler on precisely the drift the type exists to catch:
the day the console read a field the SDK did not declare, the type system had the
information to say so and was told not to. So the fix is not only "add the
field", it is **delete the mirror and the cast**, which is why the ui change here
is a deletion rather than an addition.

Keying the invitation controls on the wrong flag is not hypothetical — it shipped
in `v0.38.0` and the ui-e2e run caught it. `invitation_pending` and
`pending_first_signin` are ORTHOGONAL and BOTH true on a pending invitation,
which is what makes the wrong one pass every happy-path test; they diverge only
on a settled invitation and a bulk import. A consumer trusting the published type
had no field to key on but the wrong one. The doc comment on the new field
therefore spends more lines on the distinction than on the field, deliberately —
a one-line `invitation_pending?: boolean` would have been an accurate type and a
useless one.

**Released rather than left in-repo.** The standing plan was to hold this for the
next `web-admin` roll so the repack gotcha is paid once. Rejected: an unpublished
type is the "documented, wired, does nothing" shape this workspace hit four times
in a week — every installed consumer still resolves `0.8.17`, so a type sitting
correct in `main` protects nobody. The gotcha cost one staging step that
`publish-npm.yml` already automates.

**Changelog backfill.** `CHANGELOG.md` jumped `0.8.12` → the current version
while `package.json` read `0.8.17`; `0.8.8` and `0.8.13`–`0.8.17` had no entries
at all. Their only record was a prose paragraph inside `ui/web/vendor/README.md`
— a vendoring note in a different repo, which is how a changelog goes missing
without anyone noticing. All six are backfilled from the version-bump commits,
and the vendor README now carries the version table only and points at the
changelog for the why. A release note stored next to the tarball is a note that
exists for exactly as long as the tarball does.

## 2026-08-03 — `acceptInvitation` ships with the tests the feature commit skipped (go `0.44.0`, ts `0.35.0`, java `0.34.0`)

Issuer `v0.82.0` (ADR-095 D5) adds `POST /me/invitations/{tenantId}/accept`, and
the SDK wrapper for it landed in the previous commit **with no test in any of the
three languages** — while its mirror, `rejectInvitation`, has one in all three.
That asymmetry is the decision worth recording, because the wrapper is three
lines of path construction and the temptation is to call it too small to test.

It is not, and the mutation check says so: repointing the Go implementation at
`/reject` — a one-character-class edit, the exact slip a copy-pasted mirror
invites — fails both new tests. The wrapper's entire job **is** the path, so an
untested wrapper has nothing verified about it at all. A caller who asked to
accept an invitation and silently declined it has no recovery: `reject` is
terminal for that lifecycle row, and the invitee must be invited again by someone
else.

The second test per language pins the ERROR CODE rather than the status. `409`
carries both `not_invited` (you are already an active member — nothing to do) and
`not_pending` (the invitation was answered, revoked or expired — ask for a new
one). The remedies differ and only the code separates them, so a status-only
assertion would pass against an SDK that flattened both into a generic conflict.
Same reasoning as the `owner_cannot_be_revoked` test that already sits beside it.

Nothing was changed about the shipped behaviour — this release is tests, the
version bumps, and two documentation corrections. The SPEC header and its §12 tag
matrix had gone stale on 2026-07-15, advertising `go/v0.32.0` while `go/v0.43.0`
was live: eleven releases of drift in the one table whose stated purpose is to
say which tag matches this document. Refreshed here rather than filed, because a
version table that is known-wrong is worse than absent — a reader who distrusts it
gains nothing from it, and one who trusts it installs an SDK missing the surface
they are reading about.

## 2026-08-02 — dropping `allowedDomains`: a removed field is safer than a stale one (go `0.43.0`, ts `0.34.0`, java `0.33.0`, web-admin `0.8.17`)

Issuer `v0.77.0` (ADR-094 R3) deletes `tenants.allowed_domains`. The SDK
question was whether to remove the field or leave it as a harmless no-op for one
release, which is the usual courtesy for a breaking wire change.

Left in place it would not have been harmless. `Tenant.allowed_domains` is typed
`string[]` (non-optional) in `@realm-id/web-admin`, and the issuer stops sending
it — so `t.allowed_domains.length`, which is what every consumer actually
writes, keeps typechecking and throws `Cannot read properties of undefined` at
runtime. A field that is present in the type and absent on the wire converts a
compile-time error into a production crash; that is strictly worse than the
breakage of deleting it, which surfaces at build time in the caller's own repo.

Java takes the sharpest hit and it is accepted rather than worked around: the
`of(displayName, allowedDomains, owner)` overload is deleted outright instead of
being deprecated to a no-op. A no-op overload would silently accept a list of
domains and discard them — the caller's code compiles, runs, and quietly does
not configure the SSO they asked for. Source-incompatibility is the honest
signal.

The replacement is not a rename. Domains that auto-provision are now
`tenant_domains` grants requiring PROOF of control, reached through the domains
API, so there is nothing on `create` to point the old field at — which is also
why a bulk-imported org starts with its domains inert (ADR-094 §Consequences,
no bulk-approve path). Recorded in SPEC §6.1 so a partner reading only the spec
does not plan a migration around a field that cannot exist.

## 2026-08-02 — on-behalf-of reaches the typed surface by DERIVING a client (ts `0.33.0`, java `0.32.0`)

A partner BFF acting for a signed-in user forwards that user's verified access
JWT as `X-User-Token` beside the platform bearer (ADR-056; the bare
`X-On-Behalf-Of-User` id stopped being an identity in issuer v0.66.0). Go has
carried it on every typed method since `go/v0.37.0`; **TS and Java could send it
only on `realm.me.*`**, so a partner calling `tenants.list()` for a user had to
drop to raw HTTP. ADR-094 flow 1 — an org admin claiming a domain through their
platform's own console — cannot be built until that is closed, which is why this
is R1 of that work rather than a standalone SDK chore.

**Client derivation, not a per-call option.** Threading a `userToken` through
every typed method meant ~104 signature changes per language, each one a
breaking-ish churn on a locked spec, and every new method a fresh chance to
forget. `realm.withUserToken(jwt)` instead rebuilds the resource bundle around
one derived transport: the header reaches every method, present and future, and
**not one signature moved**. The cost is a second object graph per call site —
cheap, because everything expensive (platform-token manager + cache, verifier,
JWKS cache) is *shared* with the parent. Those are all platform-scoped; nothing
user-scoped is shared, which is what makes sharing safe.

**Why Go's mechanism could not simply be copied.** Go uses a context value, so
it needed zero signature changes and reaches `Do` and typed methods alike. TS
and Java have no ambient request context. The Java-shaped equivalent would be a
`ThreadLocal` — rejected: this SDK targets virtual threads, where an ambient
token that must be set and cleared around every dispatch is a leak waiting to
happen, and a leaked identity here is *authorization as the wrong user*. A
mutable field on the realm handle was rejected for the same reason one step
down: the handle is long-lived and shared across requests, so one request's user
would bleed into the next. Derivation makes that failure unrepresentable — a
derived handle cannot mutate its parent, and Java refuses an empty token rather
than returning a handle that *looks* user-scoped and silently calls as the bare
platform credential.

**A bug found on the way: the header could have been sent twice.** `me` sets
`X-User-Token` as a per-call header; the new transport sets `x-user-token`.
Header names are case-insensitive, but both languages' merges were plain map
writes keyed on the literal string — so both would have gone on the wire, and
`fetch` joins duplicates with a comma while `HttpRequest.Builder.header()`
appends. The issuer would have received `"a, b"` and rejected a token neither
half authored. Per-call header names are now lower-cased on the way in, so a
per-call value *overrides* rather than *joins*. Both suites assert on the raw
header list, not the folded map — folding is exactly what hides this class of
bug.

**Also corrected: the TODO that scoped this work was wrong.** Both `sdk/TODO.md`
and the root `TODO.md` carried "re-confirmed 2026-07-28: 0 matches for
`X-User-Token` in `ts/src` and `java/src/main`". Both languages already sent it
on `/me`. The real gap was never absence, it was reach — and a scoping line that
says "absent" points at a different, larger fix than one that says "cannot ride
the typed path". Both entries now record the correction, because a grep pasted
into a TODO is a timestamped claim, not a fact.

## 2026-07-30 — ADR-092 surface: a `me` namespace, and the picker is not an error

The issuer shipped ADR-092 (single-tenant membership + the D5 picker + membership
self-service). This change types that contract in all three SDKs. It is purely
additive — no existing field, method or signature moved — because the issuer
side is already live and older SDK builds must keep working against it.

**A new `realm.me.*` namespace rather than methods on `auth`.** `auth.*` is the
credential-exchange surface (login, refresh, MFA, session revoke); these three
routes are *membership* operations that happen to be self-scoped. Hanging them
off `auth` would have made "the thing you call with a user's token" the
organizing principle, which is transport, not meaning. `me` names the subject,
which is the actual invariant: no path parameter here can name someone else.

**Two auth modes, no user-id mode.** Direct (`userBearer`) and BFF (`userToken`
→ `X-User-Token` beside the platform bearer) mirror the rest of the SDK. The
existing `resolveOnBehalfOf` trio was deliberately NOT reused: its `UserID` arm
sends `X-On-Behalf-Of-User`, which issuer v0.66.0 removed as an identity
assertion (`401 x_user_token_required`). Offering it here would have shipped a
mode that cannot work, and worse, one that *looks* like the authenticated path.

**The picker is typed on the SUCCESS response, not as an error.** The tempting
shape was a `tenant_choice_required` throw, symmetric with `mfa_required`. It
would have been wrong: the issuer mints a real access token and a real refresh
token in this state, and turning that into an exception would have forced every
consumer to catch-and-continue to stay logged in. The rule this encodes — a
reconciliation prompt is not an authentication failure — is the same reason the
issuer does not refuse the login: refusing strands exactly the users the drain
exists to resolve.

**`singleTenantPendingReconciliation` typed BESIDE `config`, not inside it.**
The issuer puts it outside the settings bag because it is derived state, and the
SDKs preserve that seam rather than flattening it for convenience. Modelled as
`*int` / `number | undefined` / `Integer` so ABSENT (rule off, not reported) is
distinguishable from `0` (rule on, fully drained) — a UI that renders "0 users
pending" for a realm that never enabled the rule is reporting a fact it does not
have.

**Seven error codes registered in the known set.** Six of them are 409s. Without
registration they all collapse to the generic `conflict` and the caller cannot
tell "transfer ownership first" from "you wanted `leave`, not `reject`" from
"there is nothing to settle" — three different remedies behind one status. This
is the same reason the integration codes were registered in ADR-082/083.

## 2026-07-28 — cookie shadowing: read every candidate, and evict the twin

**Reported by Traide from a live incident.** Their analysis was correct on every
point; I re-verified it against `middleware.go` and `RealmFilter.java` before
acting rather than taking the report on trust, and both SDKs had the defect
exactly as described.

### RCA

**Symptom** — after a partner set `REFRESH_COOKIE_DOMAIN=.traide.co.in` on a
deployment with live sessions, every page reload logged the user out. `POST
/auth/token` returned `401 refresh_invalid` on every attempt, deterministically,
from the moment the existing access token expired. Logging out and back in did
not help; neither did waiting. The only recovery was deleting cookies by hand.

**Root cause** — three decisions that are individually reasonable and jointly
unrecoverable. (1) `setRefreshCookie` writes `Domain: opts.CookieDomain`, and
per RFC 6265 a Domain-scoped `Set-Cookie` cannot overwrite a host-only cookie of
the same name — they are separate jar entries, so a scope change *forks* the
cookie rather than moving it. (2) `readRefreshToken` used
`(*http.Request).Cookie`, which returns the first match and silently discards
the rest; RFC 6265 §5.4 orders equal-path cookies by creation time, so the
first match is the OLDER, already-rotated one. It never self-heals and never
intermittently works. (3) `clearRefreshCookie` also scoped itself to
`CookieDomain`, so logout could not clear the shadow — which is what removed the
last recovery path.

The originating mistake is (2): treating "the refresh cookie" as a value when
the platform models it as a *set*. Once the read is a first-match, (1) and (3)
turn a transient inconsistency into a permanent one.

**Why it wasn't caught** — every test wrote and read the cookie within a single
configuration. Nothing exercised a CONFIGURATION CHANGE against pre-existing
state, which is the only way to produce two cookies of one name; the whole
defect lives in the transition, not in either steady state. The option was also
documented as `CookieDomain string // optional`, which reads like a free-form
knob rather than a one-way door.

**Fix** — read every candidate and try each until one mints (this alone restores
service for already-stranded browsers, because the valid token was in the header
the whole time), plus actively evict the other scopes on every write and on
logout so the jar converges instead of accumulating. `CookieDomainMigrateFrom`
covers the direction the SDK cannot infer. Logout revokes every candidate.

**Prevention** — tests that assert the *transition* rather than a steady state,
in both SDKs; SPEC §10.4 now documents the hazard and the migration; the option
comments carry the warning at the point of use.

### Decisions worth recording

**Trying each candidate is only safe because this issuer has no reuse
detection.** I checked `authsvc.MintForTenant` before implementing the reporter's
suggested fix: an unrecognised refresh hash resolves to nothing and returns
`ErrNotAuthenticated`, revoking nothing. Had the issuer treated refresh replay
as a breach signal and killed the session family — a common and defensible
design — then "try each candidate" would have been *worse than the disease*,
handing it one stale token per request. That constraint is now a comment at both
call sites, because the safety of this loop is a property of the server, not of
the SDK, and a future reuse-detection feature would silently invalidate it.

**Both halves, not just the cheap one.** Reading every candidate alone would
have restored service while leaving every affected browser permanently carrying
garbage, and left logout still unable to clear it. Eviction alone would fix new
sessions and strand existing ones. They address different things and the
reporter was right to ask for both.

**Report the FIRST failure, not the last.** With one cookie the two are
identical; with several, the first is the error the old code would have surfaced.
Partners branch on `refresh_invalid`, and a fix for a cookie problem must not
change the error shape of an unrelated failure just because a browser happened
to be carrying a twin.

**Scope comparison trims the leading dot.** `.example.com` and `example.com`
name the same scope under RFC 6265 (and Go's `http.SetCookie` strips the dot
anyway). A raw string compare between `CookieDomain` and `CookieDomainMigrateFrom`
would let a partner who spelled the two settings differently delete their own
live cookie on every write — the same self-inflicted-logout class this change
exists to remove.

### What we could not answer

Their §4.4 asks us to confirm the blast radius across other realms. **We cannot
enumerate it.** `CookieDomain` is configured in each partner's own deployment of
the SDK; RealmID never sees it, so there is no query that lists affected realms.
The honest answer is that the symptom is observable from our side but the cause
is not: a realm whose users were stranded this way would show a sustained
elevated rate of `refresh_invalid` at `/auth/token` against otherwise healthy
logins. That is a proxy, not an enumeration, and it needs the fix shipped before
it is worth acting on.

## 2026-07-28 — web-admin 0.8.16: publish permissions, not a marker to expand

ADR-090 has the issuer resolve the caller's effective permission set per
membership. The SDK's only decision was what shape to expose.

We publish the resolved array and no expansion rule. The tempting alternative —
document "if `is_owner`, treat as all" — is smaller on the wire and would have
kept the type unchanged. It is wrong twice: it re-creates the marker-inference
bug ADR-090 removes, one layer up in every consumer rather than once in the
server; and it is incorrect for a capped principal, where an owner's effective
authority is `catalog ∩ permissions_cap`, not the catalog. A consumer that ORs
in `is_owner` for convenience gets it wrong in exactly the case that matters.

`is_admin_tenant` ships alongside because `permissions` alone over-reports: the
realm-scoped gate has a structural precondition (sitting in the realm's admin
tenant) that no permission string encodes. Naming it as its own boolean is
honest; folding it into the array would assert a gate scope per permission that
has not been audited yet.

Both fields are optional, and the doc comments say absent means UNKNOWN rather
than none. A consumer that reads absent as "no permissions" would blank its
console against an older BFF mid-rollout — a worse failure than briefly showing
a control the server refuses.

## 2026-07-27 — ADR-089's doc debt: the spec still described the refresh step it deleted

**Problem.** ADR-089 removed the platform refresh token, and `sdk/go` + `sdk/ts`
were updated in lockstep. The *documentation* was not, in four places that all
contradicted `SPEC.md` §190's own "there is no platform refresh step":

- `SPEC.md` §6 — "refreshes via `POST /auth/token`" as the management-call lifecycle.
- `SPEC.md` §"Auth header" — listed "the platform refresh token" as a legal bearer.
- `SPEC.md` §4.x — contrasted the user lane against "a dead platform refresh".
- `java` `PlatformTokenManager.invalidate()` — "the refresh token is preserved so
  the next `getToken()` can try `/auth/token`", 40 lines below that class's own
  correct ADR-089 note. There is no refresh field in the class at all.

**Why it matters more than a typo.** `sdk/CLAUDE.md` makes SPEC.md law — "if a
language SDK and SPEC.md disagree, fix the SDK." A stale spec therefore doesn't
just misinform, it authorizes re-implementing the withdrawn behaviour. And these
are the paragraphs a partner reads while debugging exactly this path: Traide's
2026-07-27 reply (§5) caught the same class of defect in the issuer's comments,
having traced a live bug through them.

**Decision.** Correct all four to state the absence positively (re-mint from the
bootstrap credential; `POST /auth/token` returns `401 m2m_refresh_withdrawn` for
such a session) rather than deleting the mention — a reader arriving with an old
mental model needs to be told it changed, not to find silence.

One nuance the old wording flattened and the fix preserves: "service / platform
refresh tokens" was not uniformly wrong. ADR-089 splits `class=service` by
`auth_method`, so the ADR-071 OTP-bootstrapped service account *keeps* its refresh
token; only the platform/api-key lanes lost theirs.

**Tradeoff.** Doc-only, so no version bump — java `0.29.0`'s published javadoc
carries the stale sentence until the next release. Judged acceptable: the code it
describes is correct, and forcing a release to fix a comment costs more than the
exposure.

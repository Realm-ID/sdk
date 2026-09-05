# Decision Log — Realm ID SDK monorepo

The **why** behind changes to `Realm-ID/sdk` — problem, options weighed,
decision, tradeoffs. Terse "what shipped" lives in `CHANGELOG.md`; the locked
behavioural contract lives in `SPEC.md`. This file is the running index of "why
did this change happen."

Newest first.


## Index

94 entries total — 39 here, 55 in [`DECISIONS-ARCHIVE.md`](DECISIONS-ARCHIVE.md). Newest first; archived entries link across to that file.

- [2026-09-06 (preflight) — a `Makefile`, so 61% of this repo's CI failures stop being a push-time surprise](#2026-09-06-preflight--a-makefile-so-61-of-this-repos-ci-failures-stop-being-a-push-time-surprise)
- [2026-09-05 (docs, branch cleanup) — a collision that cannot happen, a seam narrower than documented, and a stale UNRELEASED banner](#2026-09-05-docs-branch-cleanup--a-collision-that-cannot-happen-a-seam-that-is-narrower-than-documented-and-a-stale-unreleased-banner)
- [2026-09-05 (`OnIdentityResolved`) — the hook a partner could not build for themselves, and the two things everyone called it that were false](#2026-09-05-onidentityresolved-the-hook-a-partner-could-not-build-for-themselves-and-the-two-things-everyone-called-it-that-were-false)
- [2026-09-05 (role-template seat checks, override_seated) — owner ruling: an SDK must not report an error whose stated remedy is unreachable through it](#2026-09-05-role-template-seat-checks-override_seated--owner-ruling-an-sdk-must-not-report-an-error-whose-stated-remedy-is-unreachable-through-it)
- [2026-09-05 (role-template seat checks) — two new refusals stayed OUT of the general taxonomy, on purpose, matching the family they join](#2026-09-05-role-template-seat-checks--two-new-refusals-stayed-out-of-the-general-taxonomy-on-purpose-matching-the-family-they-join)
- [2026-09-04 (changelog gate) — `has_entry` matched a version anywhere in a heading's prose, not as its own subject](#2026-09-04-changelog-gate--has_entry-matched-a-version-anywhere-in-a-headings-prose-not-as-its-own-subject)
- [2026-09-04 (gaps) — three things were missing in the one way nothing detects: the code was correct and the description was not](#2026-09-04-gaps--three-things-were-missing-in-the-one-way-nothing-detects-the-code-was-correct-and-the-description-was-not)
- [2026-09-04 (ADR-107) — the cache could only say "this TOKEN is dead", and the question was "this PERSON changed"](#2026-09-04-adr-107--the-cache-could-only-say-this-token-is-dead-and-the-question-was-this-person-changed)
- [2026-09-03 (derived claims, lanes) — the guard that was a COMMENT found three call sites; the guard that is a PARSER found five](#2026-09-03-derived-claims-lanes--the-guard-that-was-a-comment-found-three-call-sites-the-guard-that-is-a-parser-found-five)
- [2026-09-03 (pagination, later) — the two input codes, and proof that a re-packed tarball does not propagate](#2026-09-03-pagination-later--the-two-input-codes-and-proof-that-a-re-packed-tarball-does-not-propagate)
- [2026-09-03 (pagination) — four list methods threw the envelope away, and the doc comments promised otherwise](#2026-09-03-pagination--four-list-methods-threw-the-envelope-away-and-the-doc-comments-promised-otherwise)
- [2026-09-01 (derived claims) — the handler ran on three lanes and all three were logins](#2026-09-01-derived-claims--the-handler-ran-on-three-lanes-and-all-three-were-logins)
- [2026-08-31 (ADR-102/105) — `login` mints now, and the parity hole that made it possible to get wrong](#2026-08-31-adr-102105--login-mints-now-and-the-parity-hole-that-made-it-possible-to-get-wrong)
- [2026-08-31 (publish, later) — the tags were re-cut after all, and the reason I predicted a red run was wrong](#2026-08-31-publish-later--the-tags-were-re-cut-after-all-and-the-reason-i-predicted-a-red-run-was-wrong)
- [2026-08-31 (publish) — the changelog gate fired before any registry saw an artifact, and the tags stayed put](#2026-08-31-publish--the-changelog-gate-fired-before-any-registry-saw-an-artifact-and-the-tags-stayed-put)
- [2026-08-31 (integrations) — the test asserted the wire shape, so the wire shape could rot](#2026-08-31-integrations--the-test-asserted-the-wire-shape-so-the-wire-shape-could-rot)
- [2026-08-31 (docs, still later) — the partner guide's siblings had never been audited at all; one had never once been true](#2026-08-31-docs-still-later--the-partner-guides-siblings-had-never-been-audited-at-all-one-had-never-once-been-true)
- [2026-08-31 (docs, later) — the full audit: the partner guide had drifted from the code wherever the code had moved](#2026-08-31-docs-later--the-full-audit-the-partner-guide-had-drifted-from-the-code-wherever-the-code-had-moved)
- [2026-08-31 (docs) — the guide told partners to send `scope` on a route that never read it](#2026-08-31-docs--the-guide-told-partners-to-send-scope-on-a-route-that-never-read-it)
- [2026-08-30 (docs) — the two things the SDK can only hand a partner as prose](#2026-08-30-docs--the-two-things-the-sdk-can-only-hand-a-partner-as-prose)
- [2026-08-30 (contract) — one key, two levels: settling the SDK error contract before publish](#2026-08-30-contract--one-key-two-levels-settling-the-sdk-error-contract-before-publish)
- [2026-08-30 (envelope) — a code the union does not name is still contract](#2026-08-30-envelope--a-code-the-union-does-not-name-is-still-contract)
- [2026-08-30 (web) — the console's step-up wrapper was always partner code, and the notes client never was](#2026-08-30-web--the-consoles-step-up-wrapper-was-always-partner-code-and-the-notes-client-never-was)
- [2026-08-30 (go) — a proxy is not a client, and the four things it re-implemented were all subtle](#2026-08-30-go--a-proxy-is-not-a-client-and-the-four-things-it-re-implemented-were-all-subtle)
- [2026-08-30 (ts, later) — a drift gate that is green while the set it guards is wrong](#2026-08-30-ts-later--a-drift-gate-that-is-green-while-the-set-it-guards-is-wrong)
- [2026-08-30 (ts) — the picker predicate and the server predicate are not the same predicate](#2026-08-30-ts--the-picker-predicate-and-the-server-predicate-are-not-the-same-predicate)
- [2026-08-30 (later) — the predicates were written in the console; the issuer is where they are true](#2026-08-30-later--the-predicates-were-written-in-the-console-the-issuer-is-where-they-are-true)
- [2026-08-30 (ADR-101) — the role→scope map is the half that makes the other half worth having](#2026-08-30-adr-101--the-rolescope-map-is-the-half-that-makes-the-other-half-worth-having)
- [2026-08-28 (`realm_id`) — a type-only field, and the pin for it was checked by nothing until it was](#2026-08-28-realm_id--a-type-only-field-and-the-pin-for-it-was-checked-by-nothing-until-it-was)
- [2026-08-28 (latest) — the enforcement half shipped in three languages and the mint half in none](#2026-08-28-latest--the-enforcement-half-shipped-in-three-languages-and-the-mint-half-in-none)
- [2026-08-27 (latest) — ADR-100 in four SDKs: making the illegal state unrepresentable in four different type systems](#2026-08-27-latest--adr-100-in-four-sdks-making-the-illegal-state-unrepresentable-in-four-different-type-systems)
- [2026-08-25 (latest) — a changelog can be present and unreachable: the order gate, and the entry that never got its number](#2026-08-25-latest--a-changelog-can-be-present-and-unreachable-the-order-gate-and-the-entry-that-never-got-its-number)
- [2026-08-25 — changelog backfill + the DECISIONS.md index/archive split, re-pointed at the real problem file](#2026-08-25--changelog-backfill--the-decisionsmd-indexarchive-split-re-pointed-at-the-real-problem-file)
- [2026-08-25 (later) — the web-admin suite tested a build artifact, and three mutations proved it](#2026-08-25-later--the-web-admin-suite-tested-a-build-artifact-and-three-mutations-proved-it)
- [2026-08-25 — the host `npm test` was broken by the workaround written to work around it](#2026-08-25--the-host-npm-test-was-broken-by-the-workaround-written-to-work-around-it)
- [2026-08-24 (later) — the taxonomy claim was measured, and it was eight codes wrong](#2026-08-24-later--the-taxonomy-claim-was-measured-and-it-was-eight-codes-wrong)
- [2026-08-24 — the changelog gate derives its subjects, and refuses to check nothing](#2026-08-24--the-changelog-gate-derives-its-subjects-and-refuses-to-check-nothing)
- [2026-08-23 (later still) — SPEC §10.4's "backstop" claim is WITHDRAWN (ADR-096 D3)](#2026-08-23-later-still--spec-104s-backstop-claim-is-withdrawn-adr-096-d3)
- [2026-08-23 (later) — tag hygiene extended to ts/java, and the one check that can actually prevent](#2026-08-23-later--tag-hygiene-extended-to-tsjava-and-the-one-check-that-can-actually-prevent)
- [2026-08-23 — the annotated/immutable tag rule was documented for seven weeks and followed by a coin flip](DECISIONS-ARCHIVE.md#2026-08-23--the-annotatedimmutable-tag-rule-was-documented-for-seven-weeks-and-followed-by-a-coin-flip)
- [2026-08-21 (last) — the SDK monorepo had no CI, which is why "add a gofmt gate" was never ten minutes](DECISIONS-ARCHIVE.md#2026-08-21-last--the-sdk-monorepo-had-no-ci-which-is-why-add-a-gofmt-gate-was-never-ten-minutes)
- [2026-08-21 (latest) — TS `listSessions` pages, and the break is deliberate](DECISIONS-ARCHIVE.md#2026-08-21-latest--ts-listsessions-pages-and-the-break-is-deliberate)
- [2026-08-21 (later still) — the last parity gap was a mode the issuer refuses](DECISIONS-ARCHIVE.md#2026-08-21-later-still--the-last-parity-gap-was-a-mode-the-issuer-refuses)
- [2026-08-21 (later) — an SDK E2E suite, and the two defects it found on its first run](DECISIONS-ARCHIVE.md#2026-08-21-later--an-sdk-e2e-suite-and-the-two-defects-it-found-on-its-first-run)
- [2026-08-21 — the Java realm pin, and the device label TS never sent](DECISIONS-ARCHIVE.md#2026-08-21--the-java-realm-pin-and-the-device-label-ts-never-sent)
- [2026-08-06 — wrap both by-id platform reads; two "blocked on a repack" items were already shipped](DECISIONS-ARCHIVE.md#2026-08-06--wrap-both-by-id-platform-reads-two-blocked-on-a-repack-items-were-already-shipped)
- [2026-08-05 — the Go `Version` const drifted a third time; the fix is the check, not the bump](DECISIONS-ARCHIVE.md#2026-08-05--the-go-version-const-drifted-a-third-time-the-fix-is-the-check-not-the-bump)
- [2026-08-03 — the browser SDK's `MeMembership` catches up to `/me`, and the changelog catches up to the versions (web-admin `0.8.18`)](DECISIONS-ARCHIVE.md#2026-08-03--the-browser-sdks-memembership-catches-up-to-me-and-the-changelog-catches-up-to-the-versions-web-admin-0818)
- [2026-08-03 — `acceptInvitation` ships with the tests the feature commit skipped (go `0.44.0`, ts `0.35.0`, java `0.34.0`)](DECISIONS-ARCHIVE.md#2026-08-03--acceptinvitation-ships-with-the-tests-the-feature-commit-skipped-go-0440-ts-0350-java-0340)
- [2026-08-02 — dropping `allowedDomains`: a removed field is safer than a stale one (go `0.43.0`, ts `0.34.0`, java `0.33.0`, web-admin `0.8.17`)](DECISIONS-ARCHIVE.md#2026-08-02--dropping-alloweddomains-a-removed-field-is-safer-than-a-stale-one-go-0430-ts-0340-java-0330-web-admin-0817)
- [2026-08-02 — on-behalf-of reaches the typed surface by DERIVING a client (ts `0.33.0`, java `0.32.0`)](DECISIONS-ARCHIVE.md#2026-08-02--on-behalf-of-reaches-the-typed-surface-by-deriving-a-client-ts-0330-java-0320)
- [2026-07-30 — ADR-092 surface: a `me` namespace, and the picker is not an error](DECISIONS-ARCHIVE.md#2026-07-30--adr-092-surface-a-me-namespace-and-the-picker-is-not-an-error)
- [2026-07-28 — cookie shadowing: read every candidate, and evict the twin](DECISIONS-ARCHIVE.md#2026-07-28--cookie-shadowing-read-every-candidate-and-evict-the-twin)
- [2026-07-28 — web-admin 0.8.16: publish permissions, not a marker to expand](DECISIONS-ARCHIVE.md#2026-07-28--web-admin-0816-publish-permissions-not-a-marker-to-expand)
- [2026-07-27 — ADR-089's doc debt: the spec still described the refresh step it deleted](DECISIONS-ARCHIVE.md#2026-07-27--adr-089s-doc-debt-the-spec-still-described-the-refresh-step-it-deleted)
- [2026-07-26 — the missing `/internal` export: why the UI reimplemented a client we shipped](DECISIONS-ARCHIVE.md#2026-07-26--the-missing-internal-export-why-the-ui-reimplemented-a-client-we-shipped)
- [2026-07-26 — the api-key `label` asymmetry: a known quirk is not the same as a decision](DECISIONS-ARCHIVE.md#2026-07-26--the-api-key-label-asymmetry-a-known-quirk-is-not-the-same-as-a-decision)
- [2026-07-24 — web-admin transport must not relabel client-side auth errors as `network` (0.8.11)](DECISIONS-ARCHIVE.md#2026-07-24--web-admin-transport-must-not-relabel-client-side-auth-errors-as-network-0811)
- [2026-07-23 — cross-realm integrations surface; the mint returns an access token only](DECISIONS-ARCHIVE.md#2026-07-23--cross-realm-integrations-surface-the-mint-returns-an-access-token-only)
- [2026-07-22 — role `assignable_to` + `can_invite_roles` typed into go/ts/java](DECISIONS-ARCHIVE.md#2026-07-22--role-assignable_to--can_invite_roles-typed-into-gotsjava)
- [2026-07-22 — `web-admin` 0.8.9: starter roles (issuer v0.54.0)](DECISIONS-ARCHIVE.md#2026-07-22--web-admin-089-starter-roles-issuer-v0540)
- [2026-07-21 — GET config + GET platform stats typed into go/ts/java](DECISIONS-ARCHIVE.md#2026-07-21--get-config--get-platform-stats-typed-into-gotsjava)
- [2026-07-20 — ADR-080 Phase B + session-revoke + MFA-self typed parity (all 4 SDKs)](DECISIONS-ARCHIVE.md#2026-07-20--adr-080-phase-b--session-revoke--mfa-self-typed-parity-all-4-sdks)
- [2026-07-16 — fix: Java `tenants().create` diverged from the contract (route + body)](DECISIONS-ARCHIVE.md#2026-07-16--fix-java-tenantscreate-diverged-from-the-contract-route--body)
- [2026-07-16 — feat: federation-bindings client in all three SDKs (S-06, ADR-057)](DECISIONS-ARCHIVE.md#2026-07-16--feat-federation-bindings-client-in-all-three-sdks-s-06-adr-057)
- [2026-07-16 — feat: IdP discovery surface ported to TS + Java (S-05, SPEC §6.10)](DECISIONS-ARCHIVE.md#2026-07-16--feat-idp-discovery-surface-ported-to-ts--java-s-05-spec-610)
- [2026-07-16 — feat: list filters (role/status/q on users, status on invitations) across all SDKs (S-07)](DECISIONS-ARCHIVE.md#2026-07-16--feat-list-filters-rolestatusq-on-users-status-on-invitations-across-all-sdks-s-07)
- [2026-07-16 — feat: `users.importUsers` ported to Go + Java (S-03, ADR-073 Release B)](DECISIONS-ARCHIVE.md#2026-07-16--feat-usersimportusers-ported-to-go--java-s-03-adr-073-release-b)
- [2026-07-16 — feat: owner-transfer optional params across all three SDKs (WP6, ADR-076)](DECISIONS-ARCHIVE.md#2026-07-16--feat-owner-transfer-optional-params-across-all-three-sdks-wp6-adr-076)
- [2026-07-16 — feat: Java `tenants.updateUserRole` parity (S-04)](DECISIONS-ARCHIVE.md#2026-07-16--feat-java-tenantsupdateuserrole-parity-s-04)
- [2026-07-15 — fix: TS + Java `auth.login` wire body diverged from the issuer contract (S-01/S-02)](DECISIONS-ARCHIVE.md#2026-07-15--fix-ts--java-authlogin-wire-body-diverged-from-the-issuer-contract-s-01s-02)
- [2026-07-15 — SPEC.md rewritten to current surface (doc sweep)](DECISIONS-ARCHIVE.md#2026-07-15--specmd-rewritten-to-current-surface-doc-sweep)
- [2026-07-15 — ADR-075: role `required_mfa_methods` write surface](DECISIONS-ARCHIVE.md#2026-07-15--adr-075-role-required_mfa_methods-write-surface)
- [2026-07-14 — ADR-074: `roles.listPermissions()` + delete `migrate_to`](DECISIONS-ARCHIVE.md#2026-07-14--adr-074-roleslistpermissions--delete-migrate_to)
- [2026-07-14 — Realign Go `const Version` to the module tag (`go/v0.30.0`)](DECISIONS-ARCHIVE.md#2026-07-14--realign-go-const-version-to-the-module-tag-gov0300)
- [2026-07-14 — ADR-073 Release B: `users.importUsers` (`@realm-id/web-admin` 0.8.3)](DECISIONS-ARCHIVE.md#2026-07-14--adr-073-release-b-usersimportusers-realm-idweb-admin-083)
- [2026-07-14 — ADR-073 Release A: `PlatformCreate.domain` optional (`@realm-id/web-admin` 0.8.2)](DECISIONS-ARCHIVE.md#2026-07-14--adr-073-release-a-platformcreatedomain-optional-realm-idweb-admin-082)
- [2026-07-14 — ADR-071/072 WP8: web-admin service-accounts + sources surface (`@realm-id/web-admin` 0.8.0)](DECISIONS-ARCHIVE.md#2026-07-14--adr-071072-wp8-web-admin-service-accounts--sources-surface-realm-idweb-admin-080)
- [2026-07-14 — ADR-071/072 WP6: ts + java parity port (ts 0.20.0 · java 0.18.0)](DECISIONS-ARCHIVE.md#2026-07-14--adr-071072-wp6-ts--java-parity-port-ts-0200--java-0180)
- [2026-07-14 — ADR-071/072 WP5: service accounts + OTP-login cutover + sources (go reference)](DECISIONS-ARCHIVE.md#2026-07-14--adr-071072-wp5-service-accounts--otp-login-cutover--sources-go-reference)
- [2026-07-13 — roles enable/disable + owner signing-keys client (go/v0.28.0 · ts 0.19.0 · java 0.17.0 · web-admin 0.7.1)](DECISIONS-ARCHIVE.md#2026-07-13--roles-enabledisable--owner-signing-keys-client-gov0280--ts-0190--java-0170--web-admin-071)
- [2026-07-11 — `is_base` on `MeMembership` (`@realm-id/web-admin@0.6.1`)](DECISIONS-ARCHIVE.md#2026-07-11--is_base-on-memembership-realm-idweb-admin061)
- [2026-07-10 — surface `idle_ttl` from login/token/refresh (ADR-070 idle session timeout)](DECISIONS-ARCHIVE.md#2026-07-10--surface-idle_ttl-from-logintokenrefresh-adr-070-idle-session-timeout)
- [2026-07-10 — SPEC §3: document the uniform-200 success/envelope contract (issuer ADR-069)](DECISIONS-ARCHIVE.md#2026-07-10--spec-3-document-the-uniform-200-successenvelope-contract-issuer-adr-069)
- [2026-07-09 — `refresh_exp` on the wire (SPEC §4.1) + drop the dead `Origin.DetachedAt`](DECISIONS-ARCHIVE.md#2026-07-09--refresh_exp-on-the-wire-spec-41--drop-the-dead-origindetachedat)
- [2026-07-08 — `SessionInfo` last-used timestamp reconciled to the issuer's `last_seen_at` field (Go / TS / Java)](DECISIONS-ARCHIVE.md#2026-07-08--sessioninfo-last-used-timestamp-reconciled-to-the-issuers-last_seen_at-field-go--ts--java)
- [2026-07-05 — `@realm-id/web@0.4.5`: `resolveTenant()` — complete a tenant-picker gate without re-running the provider redirect](DECISIONS-ARCHIVE.md#2026-07-05--realm-idweb045-resolvetenant--complete-a-tenant-picker-gate-without-re-running-the-provider-redirect)
- [2026-07-05 — `go/v0.25.0`: retire the deprecated `method` login field on the RIGHT hop (ADR-051)](DECISIONS-ARCHIVE.md#2026-07-05--gov0250-retire-the-deprecated-method-login-field-on-the-right-hop-adr-051)
- [2026-07-05 — `web-bff-realmid@0.3.6`: revert 0.3.5 — the web SDK migration targeted the wrong hop](DECISIONS-ARCHIVE.md#2026-07-05--web-bff-realmid036-revert-035--the-web-sdk-migration-targeted-the-wrong-hop)
- [2026-07-05 — `web-bff-realmid@0.3.5`: migrate login off the deprecated `method` field to `grant_type`](DECISIONS-ARCHIVE.md#2026-07-05--web-bff-realmid035-migrate-login-off-the-deprecated-method-field-to-grant_type)
- [2026-07-05 — `web-bff-realmid@0.3.4`: bump forced by a fix that shipped without a version bump](DECISIONS-ARCHIVE.md#2026-07-05--web-bff-realmid034-bump-forced-by-a-fix-that-shipped-without-a-version-bump)
- [2026-07-04 — Purge partner identifiers + private-repo references from the public SDK repo (working tree + history)](DECISIONS-ARCHIVE.md#2026-07-04--purge-partner-identifiers--private-repo-references-from-the-public-sdk-repo-working-tree--history)
- [2026-07-01 — `restore()` must send the session bearer; tokenless sessions outlive the access-TTL (web/v0.4.4)](DECISIONS-ARCHIVE.md#2026-07-01--restore-must-send-the-session-bearer-tokenless-sessions-outlive-the-access-ttl-webv044)
- [2026-06 — session-limit 412 gate: collect the issuer's nested-error siblings](DECISIONS-ARCHIVE.md#2026-06--session-limit-412-gate-collect-the-issuers-nested-error-siblings)

## 2026-09-06 (preflight) — a `Makefile`, so 61% of this repo's CI failures stop being a push-time surprise

**Problem.** `CI-FAILURE-AUDIT-2026-09-05.md` (root of the umbrella repo)
measured this repo at 35 failed / 169 runs — tied for the worst share in the
workspace — and found the pattern behind it: 86% of all cross-repo CI failures
fire on `push`, not `pull_request`, because `.git/hooks/` is empty and there is
no `Makefile` anywhere. CI is the FIRST place any gate runs, on a repo that
pushes straight to `main`. This repo's own worst offenders, by failure count:
`go/ has not changed under a released version` (8), `Publish @realm-id/sdk
(ts)` (6, needs the network — out of scope here), a changelog missing its
entry (5 + 3 across npm/maven/go modes), `The three taxonomies agree` (3),
`Typecheck` (2), `The tag has not been re-pointed since publication` (2,
release-time, immutable by then), `gofmt` (1). Every one of those except the
npm publish itself is fully determined by the working tree.

**Decision.** Add `make check` / `make release-check` / `make install-hooks` /
`make self-test`, a tracked `.githooks/pre-push`, and reuse the three existing
hygiene scripts (`tag-hygiene.sh`, `changelog-hygiene.sh`,
`taxonomy-parity.py`) rather than re-implement any of their logic.

- **`make check` mirrors `.github/workflows/ci.yml` ONLY** — the push/PR gate
  — not the publish workflows, whose gates fire at tag-push time and belong to
  `release-check` instead. It covers: workflow/Makefile command parity
  (new, see below), taxonomy parity, changelog order, `tag-hygiene.sh
  unreleased-go`, `gofmt`, `go build`/`go vet`/`go test`, and ts
  `typecheck`/`test`. **`java/`'s gradle job is deliberately excluded** — its
  dependency resolution can need the network on a cold cache and there is no
  way to tell that apart from a warm one without just trying it, which would
  violate `check`'s own no-network contract. Run it by hand:
  `cd java && ./gradlew test --no-daemon`. Runtime measured at 5-8s.
  `ts/node_modules` missing is a loud SKIP (install needs the network), not a
  silent pass — `PREFLIGHT_ALLOW_SKIP=1` is required to let a skip through,
  per the SPEC's skip rule.
- **`make release-check LANGUAGE={go|ts|java} VERSION=x.y.z`** runs the
  pre-tag preconditions for ONE language, via a new `scripts/release-check.sh`
  that itself calls `changelog-hygiene.sh` and `tag-hygiene.sh` rather than
  duplicating their rules. The three languages are genuinely different checks,
  not one flattened rule: **Go's tag IS the release** — `proxy.golang.org` may
  serve it the instant it is pushed, so the sole assertions available
  beforehand are "the const already reads this version" and "this tag does not
  already exist, locally or on origin" (the remedy, if it does, is the next
  patch version — never a re-point; `go/v0.58.0` is burned exactly this way).
  **ts/java publish from a step AFTER the tag push**, so the same
  already-exists check is about not wasting a version number, not about an
  irreversible fact — a lightweight ts/java tag caught before that publish
  step is still fixable by delete-and-recut.
  The Makefile variable is named `LANGUAGE`, not `LANG` — this shell already
  exports `LANG` as a locale (e.g. `en_IN.UTF-8`), and `make`'s command-line
  assignment overriding the environment means an omitted `LANG=` would
  silently read the locale string as the argument instead of failing the usage
  check. Verified against this box's actual `LANG` before naming it.
- **`scripts/preflight-parity.sh`** — new, wired as the FIRST gate in `check`.
  Several of `check`'s go/ts steps are not thin wrappers around a script; they
  replicate command bodies that are written inline in `ci.yml` (the `gofmt`
  block, "Build + vet", the ts steps). Per the SPEC's anti-duplication rule, a
  second copy of logic that can drift needs its own drift detector — this
  workspace has already been burned once by a private second copy of a seed
  list making tests and prod run different catalogs. The parity script asserts
  each literal command string appears in both `ci.yml` and
  `scripts/preflight-check.sh`; it does not assert step order, only that the
  two files still agree on what each gate actually runs.
- **`scripts/release-check.test.sh`** — new, run by `make self-test`, per the
  checker-tests rule (`scripts/todo-ranking-hygiene.py` shipped with a defect
  that read "file absent" as "item closed" and turned three pushes red on a
  finding that was not true; a new verdict-rendering script needs tests before
  anyone relies on its verdict). Sources `release-check.sh`'s functions rather
  than shelling out, and runs them in a subshell where a failure path calls
  `exit` — sourcing plus a bare `exit` would otherwise kill the whole test
  runner instead of failing one assertion. Exercises the field readers
  (including the "no top-level match, even when a nested field of the same
  name exists" case) and local tag-existence, against throwaway fixtures, never
  against this repo's real trees.
- **Did not touch any `.github/workflows/*.yml`** — a parallel `ci/
  workflow-hygiene` PR is open across other repos in this pass; a workflow
  edit here would conflict with it.

**Verified, not merely asserted.** `make check` passes clean on `main` at
`67b6cf3` in ~5-8s (taxonomy parity, changelog order, `unreleased-go`, gofmt,
go build/vet/test, ts typecheck + 347 passing unit tests).
`release-check LANGUAGE=go VERSION=0.58.1` confirms `go/realmid.go`'s current
const, the absent `go/v0.58.1` tag, and the changelog entry all agree.
`release-check LANGUAGE=ts VERSION=0.51.0` and `LANGUAGE=java VERSION=0.48.0`
both correctly REFUSE, because `ts-v0.51.0` and `java-v0.48.0` already exist —
those are the currently-published versions, not the next release, which is
exactly the "don't spend an already-spent version number" case the tag check
exists for.

## 2026-09-05 (docs, branch cleanup) — a collision that cannot happen, a seam narrower than documented, and a stale UNRELEASED banner

Four documentation defects and one branch delete. No behaviour changed; every
edit is prose over a surface that already shipped.

**1. `userId` cannot COLLIDE two humans — only split one.** The
`IdentityResolvedEvent.userId` doc comment said a mirror keyed on `sub` alone
"will split or collide humans across orgs", in all three languages and in
`docs/design/pre-mint-hook.md`. The split is real: `sub` is the per-tenant
`users` row id, so one human in two orgs has two. **The collision is
unrepresentable.** The issuer's `users` is ONE global table with
`id UUID PRIMARY KEY` (`issuer/internal/migrations/baseline.go:217`) and a row
id is never rewritten, so no two principals can ever share a `sub`;
`users_tenant_id_id_uidx` exists only as the composite-FK target, not as a
partitioning of the id space. The distinction is not pedantry — it decides
whether a partner writes defensive de-duplication they will never need. The
comments now say which failure is possible and state why the other is not.

**2. On refresh the hook is the MIDDLEWARE's seam, and SPEC did not say so.**
§4.1.7 rule 1 read "fires on the login lanes AND on refresh" flatly. The
refresh-lane firing lives in the refresh-enrichment step, whose ONLY caller is
the middleware — verified: Go `middleware.go:590` is `enrichRefreshMint`'s sole
non-test caller, TS is `middleware.ts:288`, Java `RealmFilter.java:319`. A
partner brokering §4.2's `token()` from its own endpoint gets no hook on that
lane **and no error** — the mint just carries whatever it was passed. Go makes
this structural (unexported); TS and Java expose it on `AuthClient` already
marked `@internal`. The login lanes are genuinely unrestricted, and the rule now
draws that line. A partner reading only the old sentence would have built a
refresh-time mirror seeding that silently never runs.

**3. The credential-bootstrapped vacuity is TOTAL, not first-mint-only.**
Rule 5 said the hook is vacuous on the credential-bootstrapped and
token-exchange lanes. True, but readable as "so it fires on the NEXT mint
instead" — and there is no next mint: those lanes are issued no refresh token at
all (ADR-089, `issuer/internal/authsvc/service.go:529,607,674`). For such a
principal the hook never fires, ever. Stated explicitly rather than left to be
inferred correctly.

**4. The SPEC header warned about a release that had already happened.** It
pinned go `v0.52.1` · ts `v0.45.0` · java `v0.42.0` and carried "⚠️ This
revision describes an UNRELEASED surface (ADR-102/103/104/105)". Those shipped
in go `0.53.0` · ts `0.46.0` · java `0.43.0` on 2026-09-01, four days and six
releases earlier; §12's matrix was staler still (`go/v0.49.0`). A stale
UNRELEASED banner is worse than none — it tells a partner not to plan against a
surface they can already `go get`. Header and matrix now read off `git tag`,
which the header's own rule already demanded, and the browser-package line off
each `package.json`.

**Branch delete — `origin/ci/workflow-hygiene` (`834fdf7`), recorded here
before removal.** Its three commits were `834fdf7` (pin gate must not flag
first-party reusable workflows), `1909625` (`OnIdentityResolved`, superseded on
`main`) and `acfac43` (SHA-pin/actionlint/pipefail/timeouts/concurrency).
Nothing is lost: its `.github/workflows` tree is BYTE-IDENTICAL to
`origin/ci/workflow-hygiene-clean` (`170d434`, what PR #2 points at) — `834fdf7`'s
pin-gate fix is folded into that commit — and its 52 branch-only lines outside
`.github/` are all OLDER revisions of what `main` now carries (`version =
"0.47.1"`, `"version": "0.50.1"`, pre-hook `AuthClient` constructors, the
`JwtPeek` silent-degrade comment `main` replaced with a refusal, SPEC `§4.1.5`
vs `§4.1.7`, this log at 91 entries vs 92).

⚠️ **A first pass read the branch as 212 branch-only lines and nearly called it
unique work.** That count includes `.github/`, which `-clean` preserves
verbatim; the deletion-relevant figure is the 52 outside it. Diff a branch
against what SUPERSEDES it, not only against `main`, before concluding anything
is lost.

## 2026-09-05 (`OnIdentityResolved`) — the hook a partner could not build for themselves, and the two things everyone called it that were false

**Problem.** A partner (Traide) resolves their authorization claim inside
`Config.Scopes` by reading their own local `users` row, which their reconciler
writes inside `OnAuthSuccess`. The mint runs first, so a brand-new user's first
login resolves against a row that does not exist yet and receives a
**scope-less token**. They repaired it with an extra `/auth/token` round trip
after the reconciler — on every login, permanently, in their auth path.

**The cause is OUR contract, which is why they could not fix it.**
`ScopeResolver.Resolve` is documented side-effect-free (`go/scopes_handler.go:28-33`)
*because* we retry it — `productRolesAttempts = 3`, backoff `{50ms, 150ms}`
(`go/product_roles.go:74,76`). Seeding from `Resolve` would run their write up
to three times per mint. They owned no earlier seam.

**Two false beliefs were removed before anything was designed, and both would
have produced worse work.**

1. **"Just document a guarantee that `Config.Scopes` runs after `OnAuthSuccess`."**
   Investigated first, on the owner's instruction, precisely because it would
   have been nearly free if true. **It is false on every lane, in all three
   SDKs.** On login/OTP/password/MFA-verify the mint happens *inside* `Auth.*`,
   which returns before the middleware fires the hook; on refresh the
   scope-resolving re-mint is an explicit statement *above* the hook block
   (`go/middleware.go:590` then `:598`). Had we written that guarantee on the
   assumption it "probably already holds", the partner would have deleted a
   working repair and shipped scope-less tokens to production.
2. **"A pre-mint hook."** The partner's name, and ours until the design pass.
   **The first mint IS `POST /auth/login`**, and identity and tenant are only
   knowable from its response. There is no seam before the first mint on any
   lane. The real seam is before the DERIVED-CLAIMS mint, which is what
   `OnIdentityResolved` names. Shipping the partner's name would have baked a
   factually false claim into a public API in three languages.

A third correction, smaller but the same shape: **`OnAuthSuccess` is Go-only
AND middleware-only** (zero hits for `authsuccess` in `ts/src`, `java/src`,
`web`; absent from Go's own direct-client path). So this was never "extend an
existing hook to two more languages" — it is a new three-language surface, and
it had to work without the middleware.

**Decision — the seam, and what it buys.** `mintProductRoles` and
`enrichRefreshMint`, configured on `Config` / `RealmConfig` / `Realm.Builder`,
**never on middleware options**. That single choice means **zero middleware
changes in any language** and direct-client support for free.

**THE CRUX: the hook's error refuses the mint, unconditionally, with no
fail-open knob.** The objection to weigh was real — this looks like handing a
relying party a veto over authentication for a whole realm. Two verified facts
dissolved it:

- **The veto already exists.** A failing `Config.Scopes` already fails every
  login on that realm (`go/scopes_handler.go:114` → `go/auth.go:658` →
  `go/auth.go:561`). This adds no new class of failure.
- **It cannot fail an authentication, only the DELIVERY of a session.**
  `LoginMintError` hands the session back rather than discarding it
  (`go/auth.go:562-565`); the issuer-side session already exists.

Against the two house precedents: the **seat-guard** shape applies (do not
proceed on an unknown), and the **revocation fail-open** shape does not — both
of its arguments fail here, because this is not "never worse than the status
quo" (there is no status quo to preserve) and it makes no datastore a hard
dependency of anything that did not already depend on it.

Owner rulings, 2026-09-05: **fires on refresh as well as login** — all three
middlewares require `tenant_id` on the refresh route and none has a
tenant-choice route, so in a BFF deployment the refresh route IS the
tenant-choice route, and login-only would have shipped a known hole in exactly
the deployment class that asked for this. **No fail-open knob** — a partner
expresses fail-open by returning nil, and adding a knob later is additive while
removing one is breaking. **No SDK-imposed deadline** — we do not bound
`ScopesHandler` today, so bounding only the new hook would be theatre.

**The guarantee is stated as what it is.** "Once per derived-claims resolution",
never "once per authentication": it is **vacuous on the credential-bootstrapped
and token-exchange lanes**, which resolve no derived claims at all, and the
spec says so rather than implying coverage it lacks.

**Tests — the defect that let this ship is a testing defect, and it is closed.**
No Go test configured both `Scopes:` and `OnAuthSuccess:`; the two features were
exercised in disjoint universes, so their relative ORDER was untested in both
directions. All three languages now carry a causal test that fails when the fire
site moves below scope resolution, and **all three were mutation-verified** by
actually moving it. Go additionally demonstrated the limit of the static guard:
under that same mutation the AST co-occurrence check **stayed green**. It proves
both things are called; it can never prove which ran first. Keep both; neither
substitutes for the other.

**Corrections to the record made here.**
- `SPEC.md` §4.1.2 claimed the handlers are wired as a Go functional option and
  a TS `TokenManagerOptions` field. The code has never done that — `Config` in
  Go (rationale at `go/realmid.go:112-116`), `RealmConfig` in TS. `sdk/TODO.md`
  says "SPEC.md is law" and root `CLAUDE.md` says "code wins"; they collide
  exactly here, and **the SPEC was corrected to match the code**, not the
  reverse. The new section is **§4.1.7**, not §4.1.5 — that number was already
  taken, and a first attempt at this edit created a duplicate.
- A build agent inferred that the branch this work was committed on was the
  dispatcher's coordination choice for the feature. **It was not.** The branch
  belonged to an unrelated CI-hardening effort running across 17 repos; the
  reconciliation onto `main` is recorded in that commit's own message.

## 2026-09-05 (role-template seat checks, override_seated) — owner ruling: an SDK must not report an error whose stated remedy is unreachable through it

Follow-up to the entry directly below. That work scoped OUT sending the
issuer's `?override_seated=true` query parameter, on the grounds that it is a
new parameter surface, not error-taxonomy registration. Flagged rather than
silently added.

**Owner's ruling: add it to all three SDKs.** Rationale for the record: client
parity with a shipped endpoint — an SDK that surfaces `role_template_seated`
and describes its remedy in a doc comment, while giving the caller no way to
send that remedy, is worse than not documenting the remedy at all (the same
shape as the `last_owner` and permission-doc-comment defects catalogued
2026-09-04 — a promise the SDK itself cannot keep).

### The one thing this must NOT do

`role_template_seat_check_failed` (503) stays UNCONDITIONAL. Adding
`overrideSeated`/`OverrideSeated` gives the caller a way to ASK for the
override; it must not read as a way to ESCAPE the 503 — the seat count itself
could not be taken, so retrying with the flag set changes nothing server-side.
Every doc comment added below says so explicitly, right next to the flag,
not only in the original error registration.

### Convention per language — followed each client's own existing pattern, not a new one

- **go**: `RolesClient.Delete` already takes a trailing `opts ...RoleDeleteOpts`
  variadic for exactly this shape (`migrate_to`). `RoleTemplatesClient.Update`
  and `.Delete` gained the identical convention — a new `RoleTemplateWriteOpts`
  struct with one field, `OverrideSeated bool`, appended as a variadic
  parameter. **Non-breaking**: every existing two-argument call to `Update`
  and every one-argument call to `Delete` still compiles unchanged, because a
  trailing variadic accepts zero arguments.
- **ts**: `RolesClient.delete` already takes a trailing `opts?: { migrateTo?:
  string }`. `RoleTemplatesClient.update` and `.delete` gained a trailing
  `opts?: { overrideSeated?: boolean }` in the same shape. **This DOES change
  `update`'s signature** (it had no opts parameter before), but additively —
  a third optional parameter breaks no existing two-argument call.
- **java**: `RolesClient.delete(String)` delegates to
  `delete(String, String migrateTo)` with `null` meaning absent.
  `RoleTemplatesClient` gained `update(String, RoleTemplatePatch, boolean
  overrideSeated)` and `delete(String, boolean overrideSeated)` overloads; the
  existing two-arg `update` and one-arg `delete` now delegate to them with
  `false`. **No existing call site breaks** — both original signatures are
  still present and unchanged in behavior.

### The wire-value decision: omit, never send `false`

Checked the issuer's parsing before choosing a wire shape (per the brief):
`override_seated` is accepted ONLY as exactly `true` (case-insensitive,
trimmed); anything else — `false`, empty, absent — is treated as absent. So
there is no meaningful "explicit false" to put on the wire, and all three
SDKs omit the parameter entirely unless the caller passes `true`. This is
recorded as a comment beside the flag in all three languages, not only here,
so a future edit does not "helpfully" start sending `override_seated=false`.

### Evidence

Each language's test suite proves both directions — the parameter reaches the
query string when requested, and is absent (not `=false`) when it is not,
including the explicit-`false` case in go and ts:

- go: `TestRoleTemplates_UpdateSendsOverrideSeatedOnlyWhenSet` (three subtests:
  omitted / explicit false / explicit true) and
  `TestRoleTemplates_Delete{Sends,Omits}OverrideSeated…`. Confirmed RED first
  (`git stash` on `roletemplates.go` alone → `undefined: RoleTemplateWriteOpts`
  / non-variadic call errors), then green. Full suite green, `go vet` clean.
  `go/0.57.2` unchanged — no new tag was cut for this ruling, so the existing
  bump covers it; the CHANGELOG entry was extended, not reopened.
- ts: four new tests in `role-templates.test.ts` (`update`/`delete` ×
  present/absent). Confirmed RED first (stashing `role-templates.ts` alone
  left the test's regex unmatched against a bare URL). Full suite 334/334
  green, `tsc --noEmit` clean. `@realm-id/sdk` `0.50.1` unchanged.
- java: `updateSendsOverrideSeatedOnlyWhenRequested` and
  `deleteSendsOverrideSeatedOnlyWhenRequested` in `RoleTemplatesClientTest`,
  reading `HttpExchange.getRequestURI().getQuery()` directly — the same seam
  `IdentityProviderConfigClientTest` already uses for query assertions.
  Confirmed RED first (compile failure: "actual and formal argument lists
  differ in length" against the pre-change 2-arg/1-arg signatures). Full
  `./gradlew build --offline` green. `dev.realmid:sdk` `0.47.1` unchanged.

No new version was consumed by this ruling in any language — each
CHANGELOG.md entry already open for today's registration work was extended
in place, per the brief's instruction not to reopen a version that already
carries an entry.



Issuer v0.121.0 added `role_template_seated` (409) and
`role_template_seat_check_failed` (503) to `PATCH`/`DELETE
/platforms/{id}/role-templates/{templateId}`. They are not interchangeable:
the first is a recoverable conflict (`?override_seated=true`, audited); the
second is unconditional — the seat count itself could not be taken, so no
parameter rescues it, and building a retry loop around it can never succeed.

The obvious move was to mirror `last_owner`'s 2026-09-04 registration:
add both codes to each language's general `ErrorCode` union / `knownCodes`
map, the way `last_owner` now makes `err.code === "last_owner"` work directly
everywhere. Checked against the tree before doing it, and that would have been
wrong for THIS pair. `role_template_exists`, `role_template_not_found`,
`role_template_identity_immutable`, `role_templates_unavailable` and
`role_authoring_retired` — the entire existing role-template error family —
are registered in **none** of the three general taxonomies, in any language,
and that is consistent across go/errors.go, ts/src/errors.ts and
java/ErrorCode.java, not an oversight in one of them. Instead:

- **Go** has a SECOND, domain-scoped mechanism: `roletemplates.go`'s
  `mapRoleTemplateErr` wraps the raw code in a sentinel (`errors.Join(ErrSentinel,
  re)`), so `errors.Is(err, ErrRoleTemplateExists)` works without the code ever
  reaching the general taxonomy. `ErrRoleTemplateSeated` /
  `ErrRoleTemplateSeatCheckFailed` were added the same way, alongside the
  existing sentinels, with a doc comment on each stating the override
  distinction.
- **TS and Java have no such mechanism for this family at all.** A caller reads
  the raw code from `error.details.server_code` (ts) /
  `exception.getDetails().get("server_code")` (java) — proven by the existing
  `role_authoring_retired` tests in both languages, which read exactly that
  path and predate this change. The two new codes were documented in JSDoc /
  Javadoc on `RoleTemplatesClient.update`/`.delete` with the same override
  distinction, and covered by new tests asserting they arrive via that same
  fallback — which they already did, since nothing about the generic
  unknown-code handling needed to change. **No functional change in ts or
  java for this reason** — only in Go, which has a sentinel to add to.

**Ruling for a future session**: when a new code joins the
`role_template_*` family, do not register it in the general `ErrorCode`
taxonomy in any language. Add a Go sentinel in `roletemplates.go` and document
the code on the ts/java role-templates clients; that is the established,
cross-language-consistent treatment for this family, and it differs from how
`last_owner`, the pagination codes, and the ADR-082/083 integration codes are
handled — those DO belong in the general taxonomy. The distinguishing question
is whether the existing siblings of the new code are already there.

Go: `TestRoleTemplates_ErrorsMapToSentinels` extended with both cases (RED
first — confirmed `undefined: ErrRoleTemplateSeated` / `ErrRoleTemplateSeatCheckFailed`
before adding them), full suite green. `go/0.57.1` → `0.57.2` per the
"first PR touching `go/` after a release bumps the const" rule (`0.57.1` was
already tagged). ts: two new tests in `role-templates.test.ts`, full suite
330/330 green, `tsc --noEmit` clean; `@realm-id/sdk` `0.50.0` → `0.50.1`.
java: same treatment as ts (Javadoc on `RoleTemplatesClient.update`/`.delete`,
two new tests in `RoleTemplatesClientTest` reading
`getDetails().get("server_code")` — the exact seam `ErrorEnvelopeTest` already
exercises for `role_owner_only`), full suite green (320 tests);
`dev.realmid:sdk` `0.47.0` → `0.47.1`.
Neither tagged nor published — CHANGELOG entries only, so a later release
carries real history instead of a gap.

## 2026-09-04 (changelog gate) — `has_entry` matched a version anywhere in a heading's prose, not as its own subject

**Problem.** `sdk/scripts/changelog-hygiene.sh`'s `has_entry` (the check the
app-repo changelog gate's own filing had described as "handles this
honestly") used an unanchored pattern, so `## v0.10.0 — bump the web SDK to
0.9.0` satisfied `has_entry … 0.9.0` — the *previous* release's version,
mentioned only in prose. Found while porting the same fix into the app-repo
copies of this script (root `DECISIONS.md` 2026-09-04, changelog hygiene) and
checked directly against this file rather than trusted from that filing's
claim.

**Fix.** Anchored `has_entry` so the version must be the heading's own
subject, not merely present in it. Two more defects fixed on inspection, both
already fixed in the app-repo copies and confirmed genuinely present here too:
a heading naming a version with no content beneath it before the next heading
now fails ("heading is not an entry"), and `## ` heading scanning is now
fence-aware (`fenced_headings()`), since this repo's own `CHANGELOG.md`
quotes a `## ` line inside a fenced code block documenting its own heading
grammar.

**Verified.** All 3 publish-gate modes (`npm`, `maven`, `go`) plus `order`
run green against the current tree (go 0.57.1, ts 0.50.0, java 0.47.0,
web 0.7.0, web-admin 0.17.0, web-bff-realmid 0.6.0, web-react 0.5.1) — every
package's entry is its own heading with real content. No changelog gap found;
nothing edited to make it pass.

## 2026-09-04 (gaps) — three things were missing in the one way nothing detects: the code was correct and the description was not

**Context.** Building ADR-107 and answering an integrator's questions turned up
three defects that share a shape. None is a bug in behaviour. In each, the code
does exactly what it says, and what it says is either absent or describes a
property the caller does not get. Every one passed every test anyone had.

**1. Java never had ADR-041's `RevocationCache`.** go and ts shipped it with
that ADR; Java shipped nothing. So a Java partner had no stop-the-bleed between
logout and the access token's stateless expiry — 900s by default — and no
signal that the capability was absent.

What makes this worth recording is *why it stayed invisible for that long*.
Nothing failed. No interface was missing from a place anyone looked, because the
interface was missing from every place. And `TokensClient.isRevoked` sits one
package away doing a different job (the SPEC §6.7 cache of a token the caller
already holds), so a glance at the Java surface reads as "revocation: present".
It surfaced only because ADR-107's D2 argued that widening this interface would
"break ts and Java at runtime, silently" — an argument about a thing that was
not there. **A rationale asserting a fact about a language nobody had checked is
how the gap survived its own review.**

Decision: port it, and assert the CONSULTATION rather than the cache. The tests
were mutation-checked — stubbing the verifier's branch to `false` fails
`revokedJtiIsRejected` and `revocationCacheOutageFailsClosed`. A published
interface the verifier never reads would be **worse** than the honest absence,
because absence at least does not read as protection.

**2. `last_owner` was promised by doc comments and declared by no taxonomy.**
The issuer returns it on both owner-protection paths. Two SDK doc comments name
it. `knownCodes` / `KNOWN_CODES` / `ErrorCode.java` did not, so
`mapErrorResponse` fell back to the status and every caller got a generic
`conflict`.

Found because a partner said their handler "had no `last_owner` case", and had
recorded it as evidence of a MISSING upstream protection. The protection exists
and fails closed (`httpapi/tenants.go:1715` and `:1767`). What was missing was
any way to know — and a doc comment describing a code the SDK then flattens is
worse than silence, because you write the branch, test it against a mock, and it
never fires in production.

⚠️ **`scripts/taxonomy-parity.py` structurally cannot catch this class.** It
compares the three languages to each other, and all three were equally missing
it. That gate's own header says agreement is what a shared oversight looks like;
this is the first case where its own blind spot was the thing that bit. A gate
against the ISSUER's emitted codes would catch it, and does not exist.

**3. Three ways to hold a correct API wrong.** All from the same integrator,
all where the signature is right and the documentation oversells it:
`LivePermissionResolver` keyed off the token's own claims (two operands, the
second a function of the first's source); `capAllows` being a ONE-operand check
on human sessions, since `permissions_cap` is minted in exactly one place and a
non-key session never carries one; and an ADR-097 compatibility ramp keyed on
"is `scope` empty", which is dead code until the day it decides everything.

The `capAllows` one is the sharpest. Its doc comment leads with "BOTH operands
must say yes" — true of key-derived tokens and false of the human sessions most
partners point it at. The required-parameter trick makes the insecure
one-operand form inexpressible and does nothing about the second operand's
provenance; that is a real limit of the design, now written down as one rather
than left to be discovered.

**Tradeoff accepted.** All three shipped in the ADR-107 release rather than
waiting, because two of them are corrections to text a partner is reading right
now, and the third closes a security capability Java never had. The cost is a
release carrying work from two unrelated efforts, which the changelog separates
into two entries rather than blurring.

**What did NOT get fixed.** The suspension carve-out stands: only `deactivated`
is guarded, so suspending the sole owner still succeeds and can leave a tenant
with no administrator. It is now documented in the served spec instead of being
silently reachable. Changing it is a behaviour change and belongs to whoever
owns that decision, not to a documentation pass.

## 2026-09-04 (ADR-107) — the cache could only say "this TOKEN is dead", and the question was "this PERSON changed"

**Context.** Three partners have asked for the same thing and each built the
same workaround: a hand-rolled `user → live jtis` index in Redis, so a demoted
admin's access token can be killed before it expires. The window is
`access_ttl_seconds`, **900s** by default, and inside it a just-demoted admin
can call `POST /users/{id}/role` and re-promote themselves.

The SDK already ships `RevocationCache` (ADR-041). It looked like the answer and
is not: it is a **jti denylist**, and it serves logout for exactly one reason —
the user presents their own token, so the SDK holds the jti at the moment it
needs to deny it. An admin demoting a colleague holds neither that colleague's
token nor its jti. **Demotion is not a missing feature of that cache; it is
structurally inexpressible on a jti key**, whatever the interface is called.

**Options.**

1. *Widen `RevocationCache` with a subject method.* Rejected. Partners have
   their own implementations behind it. Adding a method breaks Go at compile
   time — loud, and recoverable — and breaks **ts and Java at runtime,
   silently**: a duck-typed object simply lacks the method, demotion never
   fires, and nothing is observable. A cache that reports nothing is a failure
   this workspace has now recorded three times.
2. *Publish a revocation feed from the issuer.* Rejected for v1: an issuer
   round-trip on the hot path of every authenticated request, to close a window
   that a local marker closes just as well.
3. *A second, subject-keyed cache beside the first.* **Chosen.**

**Decision.** A new `AuthorityCache`, keyed by `sub`, storing a `notBefore`
timestamp; `RevocationCache` untouched and still serving logout. One partner
method, `notifyAuthorityChanged({subject, intent})`. A new `token_stale` 401.
The client refreshes once and replays.

**What the design is actually built against, and it is not the 900s window.**
The obvious implementation stamps "stale as of now" from the *partner's* clock
and compares it against `iat`, stamped by the *issuer's*. Two seconds of forward
skew and the freshly-minted token fails the same check → refresh → fail →
refresh, from every replica, aimed at the mint endpoint. **That loop is a worse
outcome than the window it closes.** So two guards, and they are the
load-bearing part of the change rather than a hardening pass: the marker is
stamped at `now − 30s` (erring early costs one harmless extra refresh and can
never put the marker in the issuer's future), and a forced refresh is honoured
**at most once per token** — a second `token_stale` on a token that refresh
itself produced is a hard failure. Every SDK carries both, with a test that
reproduces the loop and asserts the second mint does not happen.

**Tradeoffs accepted.**

- **A timestamp, not a flag**, because a flag cannot self-heal: it would reject
  the REFRESHED token too, locking the user out for the entry's whole TTL and
  turning a routine demotion into an outage. The test that matters most in this
  change is the one asserting the refreshed token passes the marker that caused
  the refresh.
- **`sub` is per-MEMBERSHIP on this platform, not per-person.** That is a
  feature — demoting someone in org A leaves their org B token alone, the right
  blast radius, for free — but it now leaks into an API a partner calls by hand,
  and a partner passing an identity id propagates nothing at all. Docs say it in
  the same breath; "disable this human everywhere" is out of scope for v1 and is
  one call per membership.
- **Demotion does not evict the session**, so the notify method takes an
  explicit intent rather than inferring one. A method that guessed would
  eventually guess "log them out" on a routine role edit.
- **Out-of-band changes stay stale for up to `access_ttl_seconds`** — the
  console, the CLI, a partner's own back-office. Stated as a limit rather than
  left to be discovered, and **that** is the number to quote publicly, not the
  ~0 on notified paths.
- **Multi-replica partners must run a shared backend.** Unavoidable given a
  partner-local cache, and it cannot even be made loud: the SDK cannot detect a
  second replica. The in-memory default is silently wrong there.
- **A new 401 enters the wire contract.** Old clients that collapse every 401 to
  "sign out" will sign users out on *promotion* until they upgrade — which is
  why all four surfaces ship together and why the code is announced before
  release, not after.

**A premise of the ADR was wrong, and it is recorded rather than quietly
fixed.** D2 argues the widening would break "ts and Java at runtime, silently".
Measured with `/usr/bin/grep` over `java/src/main`: **Java has no
`RevocationCache` at all** — it was never implemented there, so there was
nothing to widen and nothing to break. The conclusion survives (two keys, two
lifetimes, two questions), but the argument over-claimed by naming a language it
had not checked. The finding is worse than a bad citation: Java partners have no
stop-the-bleed on logout either, which ADR-107 does not close. Filed in
`TODO.md`.

**Nothing in the issuer changes.** That is the point of the shape: the partner
platform implements none of the mechanism.

## 2026-09-03 (derived claims, lanes) — the guard that was a COMMENT found three call sites; the guard that is a PARSER found five

**Context.** ADR-107 (issuer `docs/adr/107`) cannot ship its promotion half
until every mint carries `product_roles` and `scope`: a forced refresh that
does not re-resolve them hands back a token exactly as stale as the one it
replaced. So this was a prerequisite, not a follow-up.

### RCA

**Symptom.** `AuthClient.OTPLogin` and `AuthClient.MFAVerify` (and
`MFAVerifyOTP` through it) returned a session whose token carried **no
`product_roles` and no `scope`**. For an ADR-097 partner that token is read as
"no granted authority" and their own gate denies the holder everywhere — on the
MFA lane, immediately after the user passes a second factor.

**Root cause.** `mintProductRoles` was called from the lanes someone had
enumerated, and the enumeration lived in a code comment:
`middleware_derived_claims_test.go` opened with *"three call sites — Login,
CompleteLogin, PasswordLogin"*. That sentence was accurate when written. Two
lanes were added afterwards and the comment was not, so every existing test
stayed green while the surface it described stopped matching the code.

**Why it wasn't caught.** Every test asserted the CLAIM ("a login carries
`product_roles`") on a lane that already worked. None asserted the SET. The
file even warns about this — *"an assertion that a login carries the claim
passed throughout the entire life of the bug"* — and then pinned the lane list
in prose two paragraphs above.

**Fix.** `go/derived_claims_lanes_test.go` derives the subject list from the
package AST: every function returning a `*Session` must REACH
`mintProductRoles` (reachability, so a delegating lane like `MFAVerifyOTP`
counts), with an exemption map that is deliberately empty. `OTPLogin` and
`MFAVerify` now mint; `MFAVerify` also gained the tenant/user normalisation
every other lane already did, without which the handler would have had no user
id to resolve against. Ported behaviourally to ts and java, and the prose lane
list is deleted rather than corrected.

**Prevention.** The set is computed. A sixth lane fails the guard on the day it
is written. Same rule as the issuer's `TestRoleWriteSitesAreReviewed`.

**The finding worth keeping.** The defect report — written by a partner's
engineers off a careful reading of the same three-call-sites comment — named
**one** lane. The parser found **two**. Neither the report nor the comment was
careless; both were hand-maintained lists, and the second lane was invisible to
anyone who trusted the first. *That* is the argument for deriving a subject
list, not tidiness.

**Non-vacuity, checked in both directions.** All four Go tests, all three TS
tests and all three Java tests were run against the PRE-FIX source and confirmed
FAILING — on a copy of the tree, never by reverting the shared checkout. The
guard also refuses to run if it parses no files or finds fewer than four lanes,
so a broken walk fails as a broken walk rather than as a pass.

**Also corrected here.** `TODO.md` carried this item as "Not started" while the
refresh half of the same seam was already shipped and tested in all three
languages. A stale TODO in that direction costs a rebuild of working code; it is
replaced with its closed state. Traide reported the MFA lane and have not yet
been told it is fixed, nor that a second lane was found beside it.

## 2026-09-03 (pagination, later) — the two input codes, and proof that a re-packed tarball does not propagate

**Follow-on to the entry below**, once the issuer's stricter pagination
validation landed.

**Two codes, not one, and they are registered.** `invalid_cursor` and
`invalid_limit` (both `400`) are now in all three taxonomies. Two rather than
one because the caller's correction differs — `invalid_cursor` means RESTART THE
WALK, `invalid_limit` means FIX YOUR CONSTANT — and the repo's taxonomy is
already per-cause. Registration is the whole point: an unregistered code reaches
`RealmError.Code` only via the envelope siblings, so a Go caller would read a
bare `bad_request` while ts and Java saw the precise string. `go/v0.52.0` shipped
four ADR-101 codes missing from the taxonomy and callers could not branch on
them; each language now also has a test asserting the code ARRIVES, not merely
that the constant exists. `scripts/taxonomy-parity.py` holds at 73/72/73 with
its one pre-existing reviewed exception.

**The `limit=0` hazard was checked at the WIRE, and all four languages were
already safe.** The concern was real: `limit=0` is now a `400` where it was
previously absorbed into the default of 50, and Go's `PageOpts.Limit` is an
`int` whose unset value IS zero. But every transport guards it — Go on
`opts.Limit > 0`, TS and web-admin on `v !== undefined && v !== null && v !==
""`, Java on `e.getValue() == null` plus an empty-string check. Verified by
capturing the actual serialised URL rather than reading the code: a bare
`.page()` produces `/sources?platform_id=…`, `/tenants/t1/service-accounts`,
`/tenants/t1/users/u1/user-api-keys` and `/platforms/…/api-keys` — no `limit`,
no `cursor`. Tests now pin this per language across all four converted methods,
and each includes a non-vacuity assertion (the `platform_id` that IS sent), so
"no limit in the query" cannot pass because no query was built at all.

*An explicitly-supplied `limit: 0` still goes on the wire in TS and Java and
will now `400 invalid_limit`.* That is deliberate and left alone: the caller
asked for something meaningless and gets a coded refusal naming the fix. Go
cannot distinguish it from unset and omits it, which is the only thing an `int`
field allows.

**The correction worth recording: re-packing a tarball at the same filename does
NOT propagate, and I proved it the hard way.** `@realm-id/web-admin` `0.14.0`
had not been published anywhere, so re-packing it with the new codes looked
safe. It was not. `ui/web` pins by filename AND npm honours the lockfile
`integrity`, so after `npm install`, `npm install --force`, and deleting
`node_modules/@realm-id/web-admin` entirely, the INSTALLED bundle still lacked
both codes — npm kept serving the old content from its content-addressed cache.
This is `reference_vendored_sdk_drift` reproducing exactly, and "the version was
never published" is not an exemption: the pin is enforced against the FILENAME
and the hash, not against a registry. The fix is the rule as written — bump to
`0.15.0`, new filename, re-vendor.

The verification method changed as a result: the check is now `grep` of the
INSTALLED `node_modules/.../dist`, not of the packed tarball. The packed tarball
was correct at every point above while the installed one was stale, so checking
the artifact you just built proves nothing about what the app compiles against.

## 2026-09-03 (pagination) — four list methods threw the envelope away, and the doc comments promised otherwise

**Problem.** Three consecutive issuer releases added real SQL pagination —
S4 `GET /sources`, S5 service-accounts, S6
`GET /tenants/{tid}/users/{uid}/user-api-keys` — and every field they added was
discarded before an SDK caller could read it. `SourcesClient.List` returned
`out.Items`; the TS twin returned `raw?.items ?? []`; Java built an `ArrayList`
off `raw.get("items")`. A caller could neither page nor DETECT truncation, so
from any consumer's point of view the three releases were invisible and the
lists silently stopped at one page. All three languages' doc comments still said
they returned **"every"** source / service account / key, which those releases
had made false.

**The sweep found a fourth, and that is the finding that matters.** The report
named three endpoints; `apiKeys.list` (`GET /platforms/{id}/api-keys`) had the
same defect, and its own doc comment already SAID so — *"the issuer returns a
paginated `{items, next_cursor, total}` envelope"* — immediately before throwing
it away. A fifth copy lived in `web/packages/admin/src/api-keys.ts`, which
deliberately overrides the bundled client, so fixing `ts/` alone would have left
`ui/web` on page one. Four endpoints across three releases is not three
accidents; it is the shape of the list surface, which is why the fix is at the
surface (`Page`/`Paginated`) and not per method. The next paged endpoint now
inherits the honest behaviour instead of the defect.

**Decision — the pager, not the array.** All four now return the existing
per-language pager rather than a slice, matching what `tenants`, `origins`,
`invitations`, `federationBindings`, `driftReviews` and `contactVerifications`
have returned for releases: Go `*Paginated[T]` (`.Page(ctx, opts)` + `.All(ctx)`
as `iter.Seq2`), TS `Paginated<T>` (`AsyncIterable` + `.page(opts)`), Java
`Paginated<T>` (`stream()` + `page(opts)`). Nothing new was invented — the
convention already existed and these four were the outliers.

**`has_more` is added to the envelope in all three languages, and it is the
terminator.** Swagger marks it required on exactly these newer schemas and says
it is not derivable from `items`: a page that fills to the limit may or may not
be the last, and `total` is an estimate on some endpoints. It is also now what
STOPS the page walk, ahead of `next_cursor` — a server answering a stale
non-empty cursor with `has_more: false` has said stop, and before this
`next_cursor` alone could loop or over-read.

- **Absent is not false.** `has_more` is newer than the envelope, so the wire
  carries three states. Where the key is missing the SDKs derive the flag from
  `next_cursor`, which is exactly right for every pre-`has_more` endpoint — they
  emit a cursor precisely when another page exists. Resolving that once at the
  edge (Go's `pageEnvelope.page()`, TS's `readPage`, Java's `PageReader`) means
  `Page.hasMore` is a plain bool every caller can trust, rather than an
  `Option` every caller would mis-handle.
- **No `omitempty` on the way out.** `has_more: false` is a real answer ("this is
  the last page"); an absent key is not.

**Tradeoffs, taken deliberately.**

- *This is a breaking public API change on four methods per language.* It is a
  compile error with an obvious fix, against a silent wrong answer. SPEC §7 §
  `listSessions` records the same call being made for `0.40.0` and the same
  reasoning: a compile error beats the same call quietly returning a different
  number of rows.
- *The per-endpoint tolerances are gone* — `decodeUserAPIKeyList` and
  `decodeAPIKeyList` (both languages) accepted a flat array and, for api-keys, a
  legacy `{api_keys}` envelope. SPEC §7 locks the wire and the shared readers
  reject anything else with a `server_error`; a tolerance that only two of
  sixteen list endpoints had was the thing letting them drift from the rest.
  A malformed body now surfaces as an error instead of reading as "this user has
  no keys", which is a different and misleading fact.
- *`ServiceAccountList` (Go) is kept and marked deprecated* rather than deleted,
  so an existing type reference still compiles.

**Guard: a decode → RE-ENCODE round trip, in each SDK.** This is the specific
test this class of bug needs, and the reason is on the record. A decode-only
assertion ("the field arrived") passes whether or not the field is carried
onward — which is precisely how `go/v0.53.0` deleted `credential_methods` from
discovery: the BFF DECODED discovery into an SDK type and RE-SERIALISED it, and
every layer's own suite was green because nothing spanned the trip. So each
language gained a public re-encoder (`Page.MarshalJSON` via struct tags in Go,
`writePage` in TS, `PageWriter` in Java) and a test that round-trips a full
envelope and asserts every wire key survives, plus one pinning `has_more: false`
as an explicit false rather than a dropped key. The Java assertion compares
through JSON **text**, not two in-memory trees: Jackson distinguishes `IntNode`
from `LongNode`, which is a decoding artefact and not a wire difference — the
first version of that test failed on exactly that and would have been noise.

**SPEC first, then the fan-out.** §7 now documents `has_more`, the
absent-derives-from-cursor rule, the terminator precedence, "a list method
returns the PAGER, never a bare array", and the round-trip requirement. Per the
repo convention, the spec moved before the code.

**Deliberately NOT done.** No error-taxonomy entry for the stricter
`limit`/`cursor` validation being built concurrently in `issuer/` — that code
string is not settled and inventing one would put a wrong constant in three
published SDKs. Nothing here blocks adding it. No version bump on `ts`/`go`/
`java` and no publish; `web-admin` alone went `0.13.0` → `0.14.0` because
`ui/web` pins it as a vendored TARBALL BY FILENAME, and re-vendoring changed
content under an unchanged version is the pin-masks-the-fix trap that produced a
live Microsoft-login bug once already.

## 2026-09-01 (derived claims) — the handler ran on three lanes and all three were logins

**The problem.** A partner asked one narrow question — does `scope` survive a
refresh that does not re-request it? — and the answer was no. Tracing the fix
found the larger defect underneath it: `mintProductRoles` had exactly three call
sites, `Login`, `CompleteLogin` and `PasswordLogin`, and **all three are login
lanes**. Nothing resolved on refresh. `Token` forwards only what its caller
passes, and `middleware.go` refreshed with `{RefreshToken, TenantID,
CustomClaims}`.

So `product_roles` — a claim a partner had adopted and shipped that same day —
was dropped one access-TTL into every BFF-fronted session, silently, as an
absence rather than an error.

**Why it survived review.** `product_roles.go` states the correct contract in
writing: *"It runs on EVERY mint, refresh included, and nothing caches."* The
contract was right; one lane did not honour it. Nothing compared the two, and
every test asserted the claim on a LOGIN — which passed throughout the entire
life of the bug. **The lane was the subject, and no test had the lane as its
subject.**

**Decision 1 — one mechanism for both claims, not a `Config.Scopes` beside a
broken `ProductRoles`.** Shipping the scope handler alone would have satisfied
the partner's request and left the live defect standing next to it. The two
claims answer different questions (`scope` is granted authority, `product_roles`
is a name) but they have the same freshness requirement, so they get the same
seam.

**Decision 2 — resolve AFTER the mint on the refresh lane, and pay a second
round trip.** A handler needs a user id; the refresh lane holds a refresh token
and the subject lives in the access token it does not have yet. So: mint → read
the subject locally with `peekJWTUserFields` (no network) → resolve → re-mint.
*Rejected:* peeking the subject off the EXPIRING access token to save the trip.
It reads a token we are explicitly not verifying — its expiry is the reason we
are there — and assumes the caller still holds it.
**Confirmed by the partner the same day, with a better reason than ours:** their
BFF runs in COOKIE MODE, refreshing with `credentials: 'include'` and no
`Authorization` header, so at that point the expiring access token is not in hand
at all. The rejected option is not merely more expensive for a cookie-mode BFF —
it is **impossible**, because there is no `sub` to read. That is likely the
common partner shape rather than an edge case, which retires the option rather
than trading against it. A refresh is not on a human's
critical path the way a login is, so the round trip is the cheaper mistake.
The cost is opt-in: with no handler configured the lane still mints exactly
once, and **a test asserts the COUNT**, because a body assertion would let the
extra call creep back in unnoticed.

**Decision 3 — an error refuses the mint rather than minting without the
claim.** This matters more for `scope` than for `product_roles`: a token minted
without granted authority reads as "denied" to every gate, so a transient blip
in a partner's role store would become an authorization outage that our logs
record as a clean `200`. Same rule `ProductRolesError` already stated.

**Decision 4 — do not harmonise the nil/empty rules.** `product_roles` and
`scope` key on emptiness; `role_permissions` keys on nil, because an empty
non-nil list is a real instruction the issuer answers with a `403`. Three claims
on one request with two different rules looks like an inconsistency and is not.
It is now stated in the handler doc, the changelog and a test.

**What the partner's report got wrong, and why it mattered.** They cited
`auth.go:924` as being inside `Token`. It is inside `PasswordLogin`. Their
conclusion — that `Token` does not resolve — was right, but checking the
citation rather than accepting it is what exposed that *no* lane resolves on
refresh, turning a future blocker into a live defect. Verifying a claim you
agree with is worth the thirty seconds.

**Cost.** The go SDK moves `0.53.1` → `0.54.0`. ts and java must follow or the
parity claim is false.

### Java port (`0.43.1` → `0.44.0`) — three forks Go did not have

The semantics are the Go ones, unchanged. What needed deciding was Java-shaped.

**J1 — `enrichRefreshMint` is PUBLIC, because Java has no cross-package
internal.** Go's is unexported and `middleware.go` sits in the same package.
`RealmFilter` lives in `dev.realmid.sdk.middleware` and `AuthClient` in
`…​.auth`, so the seam had to be published or duplicated. Publishing it is the
better of the two: a partner running their own refresh lane (rather than our
filter) needs exactly this call, and hiding it would have re-created the very
gap this fixes — a resolution path reachable only from code we wrote.

**J2 — a THIRD private JWT peek, not a JWT library.** `TokensClient` peeks
`jti`+`exp`, `PlatformTokenManager` peeks `iss`; both are private methods on the
class that needs them and neither was reachable. `JwtPeek.subject` is
package-private in `…​.auth` and uses Jackson, already an `api` dependency.
Consolidating all three is worth doing and is NOT worth doing inside a fix for a
live defect — it is filed, not done here.

**J3 — additive only, because in Java a breaking change hides in a
constructor.** `UserAPIKeyWrite`'s canonical constructor did exactly that in a
recent release. So: `AuthClient` gains a 5-argument constructor and KEEPS the 3-
and 4-argument ones, `Realm.Builder` gains `scopes(...)`, and no record
component moved — `TokenRequest` already carried both `scope` and
`productRoles`. Nothing here is source- or binary-breaking.

**Not ported, deliberately: `TokenManager`.** Go leaves its equivalent alone and
so does Java. It is the single-identity daemon lane — one refresh token held
out-of-band, no browser, no session — and the derived claims belong to the
human-session lane the middleware fronts. A partner who wants them there calls
`enrichRefreshMint` themselves. Saying this out loud matters: an unexplained
asymmetry between two refresh paths is exactly what the next reader would
"fix" in the wrong direction.

**The Java RED was lane-specific and was confirmed before any implementation.**
Eight of eleven new assertions failed, and the two that carry the whole point
failed with the message they were written to print: *"the product_roles handler
was never called on the REFRESH lane"* and *"the scopes handler was never called
on the LOGIN lane"*. The three that were green from the start are the
absence-and-cost guards (`noHandlerMintsExactlyOnce`,
`emptyOrNullResultMintsNoClaim` ×2) — they exist to catch the FIX over-reaching,
not the bug, so green-before-and-after is their correct history.

## 2026-08-31 (ADR-102/105) — `login` mints now, and the parity hole that made it possible to get wrong

Four ADRs land in the SDKs together (102, 103, 104, 105). Two of them change the
SHAPE of the SDK rather than adding to it, and those are what this entry is
about.

**ADR-102 D10 makes `login` MINT, and it is a changed entry point rather than a
new one.** A `loginAndMint` alongside the old `login` would have been
non-breaking — and would have left the default wrong. Every consumer who never
knew to re-mint would keep the role-blind token, which is the exact failure the
ADR exists to remove. C0.1's bar says favour the paved path over the
additive-but-ignorable one, so `login` moves and the change is announced.

**The multi-tenant branch does NOT mint, and the reason is a silent failure
rather than a preference.** The handler is `(tenantId, userId) -> roles`; on a
login that resolves several tenants there is no tenantId to pass it. The
tempting shortcut is `selectTenant`, which every SDK already has — and it falls
back to `tenants[0]` when nothing is preferred, so wiring the branch through it
would mint for an ARBITRARY org and resolve THAT org's roles. Not an error: a
wrong answer. Every SDK's test therefore chooses `t2` and not `tenants[0]`, so an
auto-pick is visible rather than coincidentally right.

⚠️ **The parity hole had to be closed FIRST, and finding it is the reason this
entry exists.** `Session.NeedsTenantChoice`, `SelectTenant` and
`TenantRef.MFARequired` existed **only in Go**. D10's multi-tenant branch depends
on all three — it is precisely the surface that tells "unminted because MFA"
apart from "unminted because several tenants" — so TS and Java could not have
implemented D10 correctly without them. A hand-mirrored surface with a hole in it
is how the hole survived four SDK releases; the fix is to port them, and the
lasting fix is that the drift tests must be RUN with a sibling `issuer/` present
or they skip and report nothing. They were run that way here: TS 8 passed / 0
skipped, Java 268 tests / 0 skipped with the 4 drift cases among them.

**D11's error handling is the same house rule three times over.** A failing
handler retries (3 attempts, ~50ms then ~150ms) and then REFUSES the mint. It
does not mint an empty claim, because "this principal has no product roles" is
indistinguishable from the truth for a principal who genuinely has none — a
silent under-grant that surfaces as a 403 storm in the PARTNER's product with a
200 in our logs. ADR-097 D3 turned a silently dropped claim into a 400 for this
reason; `otpsvc.Issue` fails the whole call rather than reporting success on an
undelivered OTP. And the failure is a distinct SDK error wrapping the partner's,
never a `RealmError`: "your role handler failed 3 times" and "RealmID refused
your mint" are different incidents and must not look alike in their logs.

**The retry policy is what makes side-effect freedom a CONTRACT.** Retrying is
only legal because the handler is specified as a pure read, so every language's
doc comment says it is called an unspecified number of times per mint and must
not write, bill, audit or emit. A partner who logs "role resolved" inside it will
see triple entries and be right to call it a bug.

**Where the handler is wired differs by language, and one of them departs from
ADR-102 D3's letter.** D3 said "Go functional option per `WithRefreshSink`". In
this SDK `WithRefreshSink` is a *TokenManager* option because TokenManager takes
options; `Realm` does not — it takes a `Config` struct, and every other
realm-level hook (`Revocation`, `Clock`, `Logger`, `HTTPClient`) is a field on
it. The precedent that matters is the one for a REALM-level hook, so
`Config.ProductRoles` is the field. TS follows its config object and Java its
`Realm.Builder`, both as written.

**Java returns a new Session where Go and TS mutate one.** `Session` is a
`record`; the contract is identical and only the idiom differs, which is worth
saying out loud because the cross-language SPEC otherwise reads as if all three
mutate.

**ADR-105 deletes `orgScope`/`orgIDs` from four surfaces, and zero rows is not
zero surface.** Prod held 0 `user_api_keys` rows when it was measured, which is
what makes this a deletion rather than a deprecation — but the SDK TYPES break
regardless, and Java's is source-breaking on the canonical `UserAPIKeyWrite`
constructor. The `capped`/`uncapped` factories, which is what every caller should
already be using, are unaffected. The `OrgScope` constant class is deleted
outright rather than deprecated: a constant for a mode the server no longer has
is a value that can only produce a 400.

**One ADR-100 property went with it, and it had to be decided rather than
inherited.** The empty-intersection refusal stays a 403 and the narrowing still
happens — but the error's per-org PROPERTY is gone. It named the org because the
narrowing was per-org and the identical request would succeed against a different
tenant, and with one org per key there is no other org to point at. Keeping the
sentence would have advertised a "try another org" recovery that does not exist.

## 2026-08-31 (publish, later) — the tags were re-cut after all, and the reason I predicted a red run was wrong

**Supersedes the entry below on its central claim.** That entry says the tags
stayed put and recorded the tag/artifact delta as permanent. Both tags were
subsequently re-cut, with the user's approval, onto `2c5bf1e` — the commit the
artifacts were actually built from. `ts-v0.45.0` and `java-v0.42.0` now name
their own artifacts. `go/v0.52.0` was never moved and never will be.

**What re-running the publishes actually did.** `publish-npm` skipped every
package as designed (`already published — skipping` for ts, core, react,
bff-realmid, admin). `publish-maven` was the interesting one.

**The prediction was wrong, and it was wrong twice.** It was stated that
re-pushing `java-v0.42.0` would re-upload coordinates Central already holds,
Central would reject the duplicate, and a permanently red run would attach to a
tag whose release had succeeded — the argument `verify-go-release.yml`'s header
makes about gates people learn to ignore. That was asserted from reading the
workflow, not from testing it. Then, when the run went green, it was suggested
that the artifact may have been REPLACED, which was the opposite error.

**Measured.** The re-cut tag points at `2c5bf1e`, which PREDATES the guard
commit, so the re-run executed the OLD unguarded step. Gradle reported
`:signMavenPublication`, `:publishMavenPublicationToMavenCentralRepository` and
`:releaseRepository` all executed and `BUILD SUCCESSFUL`. And every file under
`dev/realmid/sdk/0.42.0/` still carries its original `2026-08-31 13:35`
timestamp — zero files stamped after the 15:24 re-run. Central accepted nothing
and rejected nothing. Immutability held; the deployment was a silent no-op.

**So the guard is kept for a weaker reason than it was added for**, and both the
workflow comment and the changelog now say so. It does not prevent a failure. It
converts a silent no-op into one logged, deterministic line, and avoids spending
a build-sign-upload cycle on an outcome that depends on the Portal's tolerance
for a republish — which is not a contract worth relying on in either direction.

**The lesson is the session's own, applied to itself.** Twice today the
conclusion came from reading an artifact — a changelog line, a workflow file —
rather than from exercising the thing. That is the same failure as the SDK tests
that asserted `role_id` was sent and stayed green while the call 400'd in
production. Reading the code tells you what it says; only running it tells you
what it does.

## 2026-08-31 (publish) — the changelog gate fired before any registry saw an artifact, and the tags stayed put

**Problem.** `go/v0.52.0`, `ts-v0.45.0` and `java-v0.42.0` were pushed to release
the breaking `integrations.install()` fix. The Go tag verified and published; the
other two failed within seconds at `changelog-hygiene.sh`. The root
`CHANGELOG.md` carried the entry, but `ts/CHANGELOG.md`, `java/CHANGELOG.md` and
`web/packages/admin/CHANGELOG.md` did not — and the gate checks the per-package
files, which is the whole reason it exists (three packages lost history to that
silence before it did).

**The gate's placement is the decision that paid off here.** It runs BEFORE the
publish steps, so nothing reached npm or Central: the failure was a docs commit
away from fixed, not an immutable-artifact problem. `go/v*` has no such luxury —
there the tag IS the release — which is why its equivalent check is a
post-publish verification with "ship the next patch" as its only remedy.

**Options weighed for the re-release.**

1. *Delete the remote tags and re-cut them at the changelog commit.* What the
   `publish-npm.yml` header explicitly sanctions ("a lightweight tag here is
   still fixable... because no registry has seen the artifact yet").
2. *`workflow_dispatch` from `main`.* Both workflows support it; it checks out
   the default branch and SKIPS the annotated-tag check by design, because a
   dispatch has no tag to check.

**Decision: (2).** Not on merit — (1) is the tidier provenance — but because
deleting a remote tag was refused by this environment's permission layer, and
working around a denial to get a tidier tag is not a trade worth making. The
dispatch published from `main`, one commit ahead of the tags.

**Tradeoff, stated so nobody re-derives it from a confusing `git show`.**
`ts-v0.45.0` and `java-v0.42.0` point at `ebd4b40`; the artifacts on npm and
Central were built from `2c5bf1e`. The delta is **the three changelog files and
nothing else** — no source, no `package.json`, no `build.gradle.kts`. The
published versions are what the tags name. If the tags are ever re-cut, move
them forward to `2c5bf1e`; never re-point a `go/v*` tag, which the proxy has
already cached.

**Verified, on the registries rather than on the green tick.** npm serves
`@realm-id/sdk` `0.45.0` and `@realm-id/web-admin` `0.12.0`; the published
`web-admin` tarball bundles `@realm-id/sdk` `0.45.0` and its compiled
integrations module contains **zero** occurrences of `role_id` — the absence
asserted, not just the presence of `permissions`. The Go proxy serves `v0.52.0`
carrying `const Version = "0.52.0"`.

## 2026-08-31 (integrations) — the test asserted the wire shape, so the wire shape could rot

**Problem.** `integrations.install()` sent `role_id` in go, ts and java while the
issuer has required a `permissions` list since ADR-101 D7. The call answered
`400 permissions_required` in production, in every language, and no one noticed.

**Why no one noticed is the point.** The SDK tests asserted the request body was
`{integration_id, role_id}`. They were green throughout. A test written against
the implementation ratifies whatever the implementation does — so when the
server moved, the test moved with the client and away from the truth. This is
the same shape as the mailer that sent nothing for two weeks while its tests
asserted `Send` was called.

**Decision.** Fix the wire shape in all three languages, and change what the
tests assert: `permissions` present AND `role_id` absent. The absence assertion
is the load-bearing half — a client sending both fields would satisfy a
presence-only check while still being wrong.

**Also decided: register the codes, do not just add sentinels.** An unmapped code
collapses to `bad_request`/`forbidden`, so a sentinel without registration
exists and never fires. Three of the four codes had no sentinel anywhere;
`install_grants_nothing` additionally turned out to be a MINT refusal that the
docs had filed under install.

**Kept deliberately.** `role_not_service_typed` and `role_not_installable` are
dead — the issuer emits neither — but the symbols stay, documented as dead.
Deleting an exported symbol is a second breaking change that buys nothing.

**Scope note.** `web-admin` bundles its own `@realm-id/sdk`, so it shipped the
same broken call and its wiring test passed *because* it resolved against the
stale vendored copy. Fixing `sdk/ts` alone would have left the published
`web-admin` broken and green. It was re-vendored in the same pass.

**Not established.** Whether any partner actually hit this. Failed installs
write no audit row (the audit is emitted after the refusal returns), so the
database cannot answer it; only the Cloud Run request log can. Queued in the
umbrella repo's TODO with that limitation stated, because the obvious query
returns zero and reads as "nobody was affected".

## 2026-08-31 (docs, still later) — the partner guide's siblings had never been audited at all; one had never once been true

**Problem.** The partner-guide audit (previous two entries) covered ONE of the
seven partner-facing documents. Its six siblings — `integration-guide.md` the
largest — had never been checked against the code, and `sdk/CLAUDE.md` already
warned the two big guides overlap unreconciled. Audited claim-by-claim against
the issuer source and the four SDK trees, the drift split into three kinds:

- **The platform moved.** `integration-guide.md` still taught opt-in BFF mode
  (`require_bff_login` — ADR-088 deleted the key and made the escort
  unconditional), partner role authoring as a MANDATORY bootstrap step
  (ADR-101: `403 role_authoring_retired`; the fix names scopes), a
  `default_invitation_role: "viewer"` example (`viewer` is gone),
  role-based integration installs (ADR-101 D7: a stated `permissions` list),
  owner-by-invitation (`owner_not_invitable`; owner is REQUIRED inline on
  tenant create), identifier mutation and invite-time collision checks as
  roadmap (both shipped — `updateContact`, `409 identifier_collision`), and
  email/phone/display_name as token claims (never minted; `mfa_at`/`scope`/
  `token_class`/`permissions_cap` are). `dual-token.md` classified the platform
  token by `scope: "platform"` (moved to `token_class`, ADR-097).
  `operations.md` pinned a compatibility matrix ~37 releases stale and carried
  a private-repo link for a doc that has lived beside it since 2026-08-28.
- **Never true.** §8.3's rate-limit table (per-key throttles, admin-REST
  per-realm budgets, numeric limits) matches nothing in the issuer, which has
  exactly ONE limiter: per-IP 5 req/s burst 20 on the public auth surface.
  Same class: `invitation_exists`, `tenant_locked_session`,
  `missing_platform_token`, `unknown_origin` (codes that exist nowhere),
  `realmid.Identifier{Phone:}` / `ErrInvitationExists` / `realmid.WithClaims` /
  `*realmid.Verifier` / `realm.identity.me()` / `@realm-id/sdk/browser`
  (symbols and subpaths that exist nowhere), and a "test issuer shipped with
  the SDK" that is not shipped.
- **The SDKs lag the issuer, and the docs were teaching the lag as truth.**
  All three `integrations.install()` clients still send ADR-101's retired
  `role_id` body, which a current issuer answers with `400
  permissions_required`. The docs now teach the issuer contract with an
  explicit lag warning; the SDK fix is filed in `TODO.md`.

**Decision.** Same rule as the partner guide: fix forward, never silently —
every correction states what changed and when, so a partner holding an old
copy can diff their mental model; a claim that was never true says so.
Customer names that had leaked into this PUBLIC repo's examples were
anonymized in the sections already being rewritten. Every fix was verified
against the enforcing source (issuer request structs and gates, the four SDK
trees), not against another document.

**Not changed.** What verified clean stayed: `middleware.md` (defaults, 412
translation, glob rules — all match `middleware.ts`/`.go`/`RealmFilter`, one
MFA-freshness paragraph updated), `error-reference.md`'s verifier and
auth-flow tables (every code present in `go/errors.go`), `dual-token.md`'s
TTL/caching/logging claims (match `platform-token-manager` and the issuer's
1..900 s bound), §8.6's audit taxonomy and 400-day retention, §9.5's cap
model, and the §4.5 sessions note (already fixed 2026-08-21). The
overlap-reconciliation of the two big guides remains open in `TODO.md` — this
audit made them agree with the CODE, not yet with each other in structure.

## 2026-08-31 (docs, later) — the full audit: the partner guide had drifted from the code wherever the code had moved

**Problem.** The `scope`-on-login defect (previous entry) was found by accident,
so the whole of `docs/partner-integration-guide.md` was audited line-by-line
against the issuer source and the three published SDKs on the working
assumption that it was not alone. It was not. The drift clustered exactly where
the platform had moved since the guide's "current as of v0.39.0" stamp:

- **§6 documented the wrong SDK.** The `realmid.Client` / `realmid.Verifier`
  tables described the issuer repo's *internal* SDK — a private import path,
  an `AuthenticateUser` that calls the deleted `/auth/user-token`, an
  `Introspect` the issuer has never exposed over HTTP, and `StaticKeys` /
  `RevocationChecker` / `CacheTTL` options the published
  `github.com/Realm-ID/sdk/go` does not have.
- **§4(a) put `custom_claims` on `/auth/login`**, where the field has been
  inert since its 2026-07-01 sunset, and never mentioned the
  `access_token_custom_claim_keys` allowlist — which defaults to empty, so the
  documented flow would 400 (or no-op) for every partner who tried it.
- **§7.2/§7.3 told migrating partners to pass `starter_roles`**, which
  ADR-101 turned into a hard `400 starter_roles_retired` on realm create —
  step 1 of the migration checklist was an outage.
- **§6.4/§6.5 pre-dated ADR-091**: it taught that an owner-bound api key
  mints a service-class credential (now `400 invalid_user_for_api_key`), that
  the create request's `scope` is cosmetic and its echo always lies (both
  fixed — `400 scope_mismatch`, echo authoritative), that a WIF session is
  implicit-all realm-admin and `mapped_role` restricts nothing (inverted:
  D1 deleted the `scope=platform` short-circuit, the mapped role IS the
  session's authority), and that a WIF-bootstrapped `platform_api` session
  can mint keys (that role deliberately lacks `platform_api_keys:manage`; the
  rotation channel is a `platform_mgmt_api` binding).
- **§8 denied two shipped features** — action-gated MFA (ADR-027, shipped as
  the OTP primitive the same file documents in §6) and automatic domain
  re-verification (ADR-094's worker) — while §6's "not-yet-in-SDK" list named
  four surfaces that are all wrapped, and the X-User-Token table said ts/java
  "not yet" for a surface that shipped 2026-08-02.
- **Four code samples would not compile**: `Token:` for `ProviderToken`,
  `OTPIssueRequest`/extra `tenantID` arg for `IssueRequest`, a `RealmID` field
  `OTPLoginRequest` does not have (twice, Go and ts), plus a CLI verb
  (`api-keys delete`) the CLI does not accept (`revoke`).

**Why it mattered.** This is the document partners integrate from, and most of
these are fail-at-the-partner-shaped: a 400 on realm create mid-migration, an
uncompilable first example, a security posture (WIF blast radius) described as
worse than it is and a mint path described as more permissive than it is.
Every fix was verified against the source that enforces it — the issuer's
request structs, gates and seeded role tables, and the three SDKs' exported
surfaces — not against another document.

**Decision.** Fix prose forward, never silently: where the old text taught a
now-closed behaviour, the correction says what changed and when, so a partner
holding an old copy can diff their mental model. Version claims
(go `0.49.0` / ts `0.42.0` / java `0.39.0` for the scope mint, ADR-089
handling, ts `0.33.0` / java `0.32.0` for `withUserToken`) were checked
against `CHANGELOG.md` and kept. The currency stamp now names the audit date
and issuer version instead of pretending v0.39.0 vintage with one refreshed
section.

**Not changed.** Everything that verified clean stayed in its own voice —
§4.1/§4.2's cap-vs-scope model, the §6.7 refresh-rotation rules, §7.3 import
mechanics, the error-code and TTL tables (all confirmed against
`internal/httpapi` and `internal/realm`), and the §6.6 shared-logic inventory,
whose every named symbol exists in the three SDKs.

## 2026-08-31 (docs) — the guide told partners to send `scope` on a route that never read it

**Problem.** `docs/partner-integration-guide.md` §4 ("Your product's roles live
in your system") ended its worked example with
`realm.auth.login({ ..., scope: scopes, rolePermissions: scopes })`. No SDK has
ever accepted `scope` on `login` — it is absent from Go's `LoginRequest`, from
ts's `LoginRequest`, and from the body ts actually builds — and the issuer's
`loginReq` has no `Scope` field either, only `tokenReq` does. §4.2 of the same
guide documents the correct route. So the guide contradicted itself across 240
lines, and the half a partner reads first was the wrong half.

**Why it mattered more than a typo.** The failure is silent and it is
fail-open-shaped from the partner's side: a TypeScript partner gets a compile
error, but a JavaScript one, or anyone copying the shape onto a raw HTTP call,
gets a `200` and a token with no `scope` claim. Their `ScopePolicy` gate is
default-deny, so every gated route then refuses every user — a confusing outage
rather than a security hole, but one debugged at the far end from the cause.
This is the `signup_mode` / `allowed_domains` shape the issuer's `v0.108.0`
`Warning: 299` header exists to announce, and that header is the only thing
that would have surfaced it.

**Decision.** Correct the snippet to the two calls the design actually
requires — `login` to validate the credential and resolve the memberships, then
`/auth/token` with the refresh token, the selected `tenant_id` and the scopes
from the partner's own role→scope map. Add a note stating the ONE-route rule and
its structural reason (the ADR-041 escort runs on `/auth/token` for every
refresh class, so a user cannot self-assert a scope), and stating the
consequence nothing said out loud before: **the token `/auth/login` mints
carries no `scope` claim at all**, so a backend must re-mint before the user
does anything.

**Also disambiguated.** `rolePermissions` IS accepted on both routes, which is
probably how the two got conflated. It is a different operand for a different
mechanism — ADR-100 narrowing of a user API key's `permissions_cap`, honoured by
`grant_type=user_api_key` alone and inert on every other grant. Passing the same
list as both, as the old snippet did, is ADR-097's "conflating any two of the
three permission-shaped things" in one line of sample code.

**Not changed.** The rule itself. `scope` stays off `/auth/login` — the escort
argument is the reason it is safe to take a partner-asserted scope at all.

## 2026-08-30 (docs) — the two things the SDK can only hand a partner as prose

**Problem.** The dogfooding refactor moved a pile of shared logic out of
RealmID's own console and BFF and into the published SDKs. A partner does not
benefit from a surface they cannot find: nothing in `docs/` named the role
predicates, `ProxyStatus`, `ParseClaimsUnverified`, the envelope readers,
`withStepUpRetry`, or the new web/web-admin resources. And two items could NOT
be shipped as code at all, which is a different problem from "not done yet".

**Decided (1): refresh-token rotation is DOCUMENTED, not shipped (REVIEW B2).**
`api/internal/middleware/refresh.go` holds an algorithm every partner BFF needs
identically — one-time refresh tokens whose reuse revokes the chain (ADR-031),
so: SETNX single-flight per session with a 5s crash-guard TTL, a 5s in-lock
debounce, a 60×50ms poll for the lock loser, and — the part nobody derives —
`context.WithoutCancel` around the mint+persist so a page reload aborting the
XHR cannot leave the session holding a spent token ("reload twice and it signs
me out", RCA 2026-07-01). Shipping it as an interface-based helper in `sdk/go`
was rejected, not deferred: the storage is the partner's, the concurrency is
subtle, and this exact code is on a live prod path where a refactor's blast
radius is every session. A wrong port is worse than no port. It is now
`partner-integration-guide.md` §6.7, written from the implementation rather than
from an idealised version of it, with the tenant-switch variant (no debounce,
poll-then-lock, and the new `sub` on the switched JWT) called out separately
because it is the more exposed path.

**Decided (2): staff-only surfaces get a partner-facing WARNING, not a
removal (REVIEW C2).** The ADR-048 aggregates (`realm.Admin` / `realm.admin`,
SPEC §7.5) and `PlatformNotesClient` are gated server-side on base-realm staff:
a partner can only ever get `403`. They stay in the published packages — the
SDKs are symmetric across runtimes and the RealmID console consumes the same
artifacts partners do — so the fix is that the docs say so out loud, in
`partner-integration-guide.md` §6.6 and beside SPEC §7.5's own text. `notes` had
already moved behind the `@realm-id/web-admin/internal` subpath (W2); this is
the half that reaches a reader.

**Decided (3): the reference BFF's six deviations are FILED as ADR-worthy, not
converged (REVIEW C3).** `api.realmid.dev` not following `BFF-SPEC.md` means the
canonical code path in `@realm-id/web` — the one every spec-following partner
takes — is the path RealmID itself never exercises, so the better-tested path is
the non-canonical one. Converging it breaks `ui/`, the CLI and any partner on
the `bff-realmid` preset; amending the SPEC makes the adapters permanent. That
choice is an ADR, and making it inside a release about something else would
bury it. Recorded in `sdk/TODO.md` § Known contract debt and stated in
partner-visible terms in `web/BFF-SPEC.md` § Reference implementation.

**Also settled while here.** `BFF-SPEC.md` never told a PARTNER's BFF that a
relayed error must preserve BOTH envelope levels — the issuer nests the gate
payload inside `error` (GoFr merges the `Response()` map), while a BFF emitting
its own gate puts it beside `error`. Now normative, in § Conventions, with the
code-less GoFr 401 named in the same place. That TODO item is closed.

**Not done, deliberately.** The two other findings from the review pass —
`web/packages/*` having no CI runner, and `parseStepUp` re-reading the 412
instead of routing through `parseErrorEnvelope` — were already filed in
`TODO.md` earlier the same day. They are left as-is rather than re-filed; a
second copy of an open item is how a list stops being trusted.

## 2026-08-30 (contract) — one key, two levels: settling the SDK error contract before publish

**Problem.** The envelope fix earlier today (`938483b`) left two divergences
standing, both filed rather than settled. Both are BREAKING to change once a
partner consumes them, and every SDK here is unpublished, so "later" meant
"never, at a cost".

1. The preserved non-canonical error code landed under a DIFFERENT key per
   language: go `Details["code"]`, ts + java `details["server_code"]`.
2. On the nested envelope shape ts and java collected only the siblings BESIDE
   `error`; go collected the ones INSIDE it too.

**Decided (1): `server_code`, everywhere; go moves.** Not taste — three checks,
in order. `SPEC.md` and `web/BFF-SPEC.md` name NEITHER key, so the spec could
not settle it and had to be written afterwards (it now has, §3.3). Then: which
name is load-bearing for a consumer that already shipped? `server_code` is read
by `@realm-id/web-admin`'s `isCode()`, `@realm-id/web`'s `membershipActionCode()`
and two console screens (`Sources.tsx`, `ServiceAccounts.tsx`), and is recorded
as the contract in `ui/DECISIONS-ARCHIVE.md`. The go write, by contrast, was
added hours earlier and sits under `## Unreleased` — no partner has ever seen
it, and its only readers are this repo's own `detailCode`/`specificCode`. So one
side of the divergence had four shipped consumers and the other had none.
Renaming the one with none is the whole decision.

The secondary reason is that the two names are not synonyms. `details` carries
envelope siblings VERBATIM, so `details.code` already means "the body literally
stated a top-level `code`". Overloading it to ALSO mean "the SDK preserved
something" made one key answer two questions; `server_code` keeps the synthetic
value distinguishable from the transcribed one. `detailCode` reads `server_code`
first and still falls back to `code`, so a `RealmError` assembled by something
other than `ParseErrorEnvelope` keeps working.

**Decided (2): all three SDKs collect BOTH levels — and this one was LIVE.**
The tempting reading is that nesting is a legacy shape nothing emits. It is the
opposite. GoFr's `createErrorResponse`
(`gofr.dev/pkg/gofr/http/responder.go`) merges every key an error's `Response()`
map adds into ONE object and renders it under the top-level `error` field. The
issuer's `sessionLimitErr.Response()` and `mfaGateError.Response()` merge their
payloads into exactly that map. So **every issuer gate payload is nested**:
`mfa_challenge_token`, `methods`, `reason`, `max_age_seconds`,
`revocation_token`, `active_sessions`. `issuer/test/CODE_GAPS.md` UI-002 records
the observed body verbatim. A ts or java partner talking to
`auth.realmid.dev` — directly, or through a BFF that relays the upstream body —
got an EMPTY details map on a step-up, i.e. a challenge with no token to answer
it. The reference BFF's own `writeStepUpChallenge` emits the beside-`error`
form (ADR-096 D9), which is why the console never saw this and why the defect
could sit behind a green suite.

Collision rule: **nested wins**, matching go's existing collection order, so a
body carrying both never resolves differently depending on which language read
it. The envelope's own `code`/`message`/`error` are never copied into `details`.

**Two findings the fix surfaced, both fixed here.**

`@realm-id/web`'s `withStepUpRetry` — the named consumer of this payload — does
NOT go through `parseErrorEnvelope`. `parseStepUp` hand-reads the 412 and read
only the top level, so fixing the parser alone would have left the actual
step-up wrapper broken against the issuer while every envelope test went green.
It now reads both levels with the same precedence.

And `@realm-id/web`'s parity gate against `@realm-id/sdk` stayed GREEN through
both divergences. The gate is real — it runs both implementations over a shared
fixture table — but the TABLE is hand-maintained, and it contained no
nested-payload body and no legacy-message body. A drift gate is only ever as
wide as its subject list; this is the same failure shape as every other
hand-maintained check list in this workspace. Five fixtures added, and the gate
now goes red on either regression. The deeper problem is filed, not fixed: that
gate has no CI job at all (`sdk/TODO.md`), so it is a local-session guard.

**Tradeoff accepted.** `details` gains keys on refusals that previously dropped
them, so a caller iterating `details` sees more than before. That is strictly
more truthful and no key changes meaning; the alternative — an opt-in — would
mean shipping the empty-details bug as the default.

**Not done.** `BFF-SPEC.md` still does not tell a PARTNER's BFF that relaying an
issuer error must preserve both levels. Filed in `sdk/TODO.md`.

## 2026-08-30 (envelope) — a code the union does not name is still contract

**RCA (bug fix).**

- **Symptom.** `role_owner_only` — the 403 ADR-101 D6 introduces, and the code
  the release currently being prepared is FOR — reached an SDK caller as a plain
  `forbidden`, with no way to tell an owner-only seating refusal from any other
  403 on the request. Found independently by two agents in one day: the `sdk/go`
  reviewer and the `api/` BFF consumer, which shipped a ~15-line `envelopeStated`
  helper that re-read the body itself purely to work around it.
- **Root cause.** Every SDK narrows a body's `code` to its own canonical union.
  That narrowing is right — a caller should not have to match an open string set
  — but the discarded original was then written NOWHERE on the nested envelope
  shape. Go's sibling sweep skipped the key `code` unconditionally; Java's
  `fromWire` returned null and the sweep excluded `code` too. The union is a
  CONVENIENCE over the wire, not a replacement for it, and the code that made it
  one was three lines of `continue`.
- **Why it wasn't caught.** The existing Go test covered the case where the
  specific code sits at the TOP level beside a canonical nested one — a shape
  the sibling sweep preserved for free. The shape the issuer actually emits for
  D6 puts the specific code INSIDE `error`, and no test named it. Go's doc
  comment had promised `Details["code"]` since the function was extracted, so
  prose and code disagreed for the entire life of the function and only the
  prose was read. Java had no envelope test at all: its mapper is private and
  every existing test drove it through a client that happened to use canonical
  codes only.
- **Fix.** All three SDKs, on BOTH envelope shapes. A stated code the union
  cannot carry is preserved verbatim — Go `Details["code"]` (what its doc
  promised and what `detailCode` reads), TS `details.server_code` (already
  correct, unchanged), Java `details["server_code"]`, matching TS. A code the
  union CAN carry still lands on `Code` alone and is deliberately NOT duplicated
  — copying it would make `detailCode()` answer for every canonical refusal and
  change what the existing sentinel mappers match on. Three adjacent defects in
  the same seam were fixed with it, because leaving them would have meant the
  BFF workaround could not be deleted: Go and TS and Java all ignored a nested
  legacy `{"error":{"error":"<msg>"}}` string (message silently became the bare
  status text — the exact regression RCA 2026-07-01 exists about), and Java's
  flat branch was gated on a present `code`, so the CODE-LESS GoFr middleware
  401 — the second of the two shapes this seam exists to handle — lost its
  message entirely.
- **Prevention.** The rule is now pinned from both sides in each language: a
  test that the uncanonical code survives, AND a test that a canonical one is
  not also copied. That second one is not ceremony — the mutation that preserves
  every stated code SURVIVED the first Go test set, and adding it turned five
  Go / two TS / four Java mutations into 11 caught out of 11. The
  cross-language KEY divergence (`code` in Go vs `server_code` in TS and Java)
  is real and deliberate — Go's is verbatim-sibling semantics that `detailCode`
  already reads, and moving either is a breaking change to a published SDK —
  and is filed in `TODO.md` for the wave-5 contract pass rather than papered
  over here.

**The second half: `StatedErrorCode`.** Preserving the uncanonical code was not
enough to delete the BFF workaround, and finding out why is the more useful
half of this entry. `ParseErrorEnvelope` NARROWS — that is its job, and a client
wants it — so a stated `forbidden` and a code derived from a bare 403 are the
same value on `Code`. The BFF does not want the narrowed code; it wants to know
whether the upstream stated one AT ALL, because a body that states none gets the
BFF's own `upstream_error`, which `ui/` branches on. No amount of fixing the
narrowing surface answers that question. So the reading moved into the SDK as
its own exported function rather than the BFF keeping a private copy: the
alternative — copying a canonical code into `Details` as well — would have made
`detailCode()` answer for every canonical refusal and changed what the existing
sentinel mappers match on, which is a real behaviour change bought for tidiness.

**Consequence for `api/`.** `envelopeStated` is deleted; the BFF's
`upstreamError` is now `ParseErrorEnvelope(...).Message` plus
`StatedErrorCode(body)`, and holds no envelope knowledge of its own. Its
`upstream_error` fallback is unchanged, so nothing the SPA reads moves. That
helper was the evidence: a consumer re-implementing the thing it imported is the
SDK telling you its contract is incomplete.

## 2026-08-30 (web) — the console's step-up wrapper was always partner code, and the notes client never was

**Problem.** Two opposite boundary errors in the browser packages. Going out:
`ui/web/src/api.ts` carried ~340 lines of self-declared "SDK gap shims" — the
ADR-094 SSO domain flow, ADR-057 federation bindings, ADR-092 D5 membership
self-service, the pre-session revocation flow — each of which any partner
integrating RealmID has to re-write, and `ui/web/src/stepup.ts`, whose own
header says "that is the pattern partners will copy" while living in a file no
partner can import. Coming in: `@realm-id/web-admin` shipped
`PlatformNotesClient` against the issuer's `/admin/platforms/{id}/notes`, a
base-realm staff-only route that returns `403` to every partner who is this
package's entire audience.

**Decisions.**

1. **The step-up wrapper moves to `@realm-id/web` with the prompt as a
   CALLBACK, not module state.** The console's version registers one prompt in
   a module-level variable; two realms on one page would fight over it, and a
   library cannot own that global. The four behaviours it has to reproduce are
   each silent when broken — misclassifying the session-limit `412` swallows a
   gate that has its own flow; reusing the presented bearer logs the user out on
   a SUCCESSFUL verify; dropping the bearer from the verify writes the proof on
   the wrong tenant and re-prompts forever; replaying through the wrapper rather
   than the raw fetch turns one refusal into a loop. So each got its own test
   AND its own mutation: six mutations, six different tests red. A suite where
   one assertion covers four behaviours would have passed three of them.

2. **`isRoleAssignableTo` and `isRoleSeatable` are re-exported SEPARATELY, and a
   test asserts the split survives.** Wave 1 split them for a reason — the first
   mirrors the server exactly (no name guards), the second adds what a picker
   needs. Re-exporting them through one name, or aliasing one onto the other,
   silently starts offering `owner` in every role picker. The test that catches
   it is the `owner` case itself, asserted in both directions.

3. **`PlatformNotesClient` moves to a `/internal` subpath, not to the bin.**
   Deleting it would break RealmID's own console for no gain; leaving it on the
   root entry point advertises an API the audience cannot call. A subpath export
   with no stability promise says both true things at once. `createOpsAdmin` is
   a superset of `createAdmin` so the console changes one import, not thirty.
   This is a BREAKING change for `@realm-id/web-admin` consumers and is the
   reason this is `0.10.0` rather than `0.9.2`. The ADR-048 aggregates
   (`admin.admin.*`) stay on the root surface deliberately — they are in SPEC
   §7.5 — but the partner docs must say staff-only (W5, C2).

4. **`@realm-id/web` keeps ZERO runtime dependencies, and pays for it with
   parity TESTS.** `@realm-id/sdk` owns `unwrapData`/`parseErrorEnvelope` and
   the membership code taxonomy, and it is itself dep-free and browser-safe, so
   a dependency was genuinely available. It was declined because `ui/web` pins
   these packages as vendored tarballs BY FILENAME, and adding a runtime dep to
   core changes that chain in the middle of a five-wave refactor. The
   alternative to a dependency is not a silent copy: the sdk is a devDependency,
   and both implementations are run over the same fixture table (23 bodies × 7
   statuses for the envelope, set equality for the taxonomy) with the parity
   assertion refusing to pass on an empty table. Two mutations confirmed it —
   drifting `unwrapData`'s sole-key rule and dropping one membership code each
   turned the gate red. Filed in `TODO.md` as a decision to revisit once the
   vendoring chain is settled, because a parity test is a gate, not a fix.

5. **`ActiveSession` stopped being declared twice.** `@realm-id/web` owns the
   row as `RevocableSession` and `@realm-id/web-admin` re-exports it under the
   old name. The two declarations had already drifted by one field
   (`device_name`), which is the whole argument in miniature.

**Tradeoff accepted.** `admin.ssoDomains` and `admin.federationBindings` are
bound to the admin's `realmId` like every other `/platforms/{id}/…` resource
rather than taking a platform id per call, so a console targeting another
platform constructs a second admin (`useAdminForRealm`, which already exists).
Consistency with the eight resources already shaped that way beat matching the
shim's signature.

## 2026-08-30 (go) — a proxy is not a client, and the four things it re-implemented were all subtle

**Context.** W1a of the SDK dogfooding refactor. The reference BFF
(`Realm-ID/api`) is the most exercised RealmID integration in existence and it
is a PROXY, not a typed client: it holds sealed issuer tokens, forwards raw
bodies, and relays raw error responses. Every partner BFF is shaped the same
way. Four things it had to hand-roll — because the SDK exposed only the typed
client path — plus the role predicates that were born in the console.

**Why these four and not the whole BFF.** Each is a PURE function whose wrong
version fails SILENTLY. That is the selection rule, and it is why the refresh
rotation (concurrency, Redis, live prod path) is deliberately left alone and
documented instead:

- **`ParseClaimsUnverified`** — hand-rolled twice in the BFF (`subjectFromJWT`,
  `mfaAtFromJWT`), split/base64/unmarshal each time. The interesting content is
  not the parsing, it is the DOC COMMENT: reading a claim without checking the
  signature is sound *because of provenance* — the token was minted by the
  issuer and has lived sealed server-side since — and unsound the moment someone
  points it at a client-supplied string. That reasoning existed in one BFF's
  comments and nowhere a partner could read it. A test asserts the warning is
  still in the file, because for a function like this the comment IS the control.
- **`ProxyStatus`** — preserve `Details` or the SPA's session-limit modal and
  MFA prompt get an empty object and the user sees a dead button. **We changed
  one thing on the way**: the BFF classifies `*RealmError` first and timeout
  second, but the SDK transport wraps a cut context as a `*RealmError` with code
  `network` and no HTTP status — so the documented "timeout → 504" was
  effectively unreachable and those requests answered 500. Timeout is now
  classified FIRST. This is a behaviour change for wave 3 to notice, not a
  transcription.
- **`ParseErrorEnvelope`** — the issuer speaks two error shapes and the
  code-less GoFr-middleware 401 is the one guards forget. The SDK already read
  both, inside an unexported function reachable only by going through a typed
  client. A proxy holding a `[]byte` and a status could not call it, so a fourth
  copy got written in `handlers.go`.
- **`MFARule` + `WhenJSONField`** — this one is not a gap, it is a FORK: two Go
  implementations of SPEC §10.4 in the same org, and the SDK's was the one
  missing the body narrowing and the config validation. The narrowing exists for
  a single real shape — `PATCH /tenants/{id}` is both "rename" and "deactivate",
  and gating both trains people to click through the prompt, which is how a
  step-up stops being a control. The ROUTE LIST stays partner data (ADR-096 D2);
  only the model moved.

**The role predicates, and the drift test that is the actual deliverable.**
`ConfersAuthority` (ADR-101 D6) and `IsRoleAssignableTo` (ADR-081) existed in
the issuer and in the console, in no SDK, in any language. Two design points:

- **`ConfersAuthority` needs NO list.** It reads the ACTION off the
  `resource:action` string, which is exactly how the issuer derives it from the
  ADR-074 catalog — so a permission RealmID adds tomorrow is classified
  correctly with no edit here. A malformed entry fails CLOSED (conferring). The
  predicate cannot drift because there is nothing to maintain.
- **The two lists that CAN drift are checked against the issuer's own source.**
  `humanOnlyPermissions` and `systemUnassignable` are parsed out of
  `internal/realmrole/{assignable,store}.go` with `go/ast` and compared. A
  hand-maintained mirror with a comment saying "keep this in sync" is the exact
  failure this workspace has been burned by repeatedly; the console file's
  comment made that promise and was already false about `required_mfa_methods`.
  The check also asserts the issuer still derives authority from
  `p.Action != "read"`, and that its assignability gate has NOT reinstated a
  per-role MFA floor — the ADR-101 interlock, since the SDK deliberately omits
  that check.

**The limitation, stated rather than hidden.** `Realm-ID/sdk`'s CI clones only
this repo, so the cross-repo check has no issuer to read there and cannot run.
It does not report a pass it did not earn: it logs `DRIFT CHECK DID NOT RUN` in
capitals and the gap is filed in `TODO.md`. It runs for real where the two
checkouts are siblings — every local session, and any CI that checks out both.
Making it unconditional needs a CI change in a repo this work package does not
own; a gate that goes permanently red in the only CI that runs it gets deleted,
which would be worse than one that is honest about when it abstained.

**Not done, deliberately.** The BFF's `api/internal/stepup` package still
exists and is still what runs in production — wave 3 does that swap, and it must
reproduce the D4 *refuse* what it cannot challenge behaviour, which lives in
`passthrough.go` and is not part of the policy model moved here.

## 2026-08-30 (ts, later) — a drift gate that is green while the set it guards is wrong

**The defect.** `NON_ASSIGNABLE_ROLES` (the private `SYSTEM_UNASSIGNABLE` as
shipped hours earlier) held `owner` and `platform_api`. The issuer's
`realmrole.NonAssignableRoles` holds a third: `platform_mgmt_api`, the ONLY
identity permitted to mint `platform_api`'s key (ADR-091 D3). A human holding it
is a credential-issuance path outside the ADR-076 owner pointer — precisely what
ADR-101 D6 exists to close — and `isRoleSeatable` was offering it. The set was
ported from `ui/web/src/roleAssignability.ts`, which has the same gap, so the
console has been offering it too.

**Why this matters more than the fix.** The entry above ships a drift gate and
argues, at length, that a hand-maintained copy without one is the failure mode
the whole refactor exists to remove. That gate was GREEN across this defect. It
compared two of the mirrored sets — the ADR-074 catalog and
`HumanOnlyPermissions` — and said nothing at all about the third. It was also
mutation-tested, and the mutations only ever touched the two sets it covered.
"I wrote a drift test" is not "the set is covered", and a gate that is green
while the thing it guards is wrong is worse than no gate, because it is quoted
as evidence. `sdk/java`'s gate found this; ours could not have.

**Decision: compare EVERY set, and by set EQUALITY.** Not membership — an EXTRA
entry has to fail as loudly as a missing one, because a set that has grown a
name the issuer never had silently removes a legitimate choice from every
picker. Now compared against the live issuer source: `NonAssignableRoles`,
`AssignableKinds`, and the ADR-094 `tenantdomain.IsValidMethod` /
`IsValidStatus` vocabularies, alongside the two already there.

**`PrincipalKind`, `SSODomainMethod` and `SSODomainStatus` became const arrays
with the union derived from them.** A bare TypeScript union is invisible at
runtime, which is another way of saying it cannot be drift-tested at all — the
type system erases exactly the thing the gate needs to read. Deriving keeps the
type identical and makes the vocabulary a value.

**The Go map reader is anchored on the VARIABLE NAME.** `store.go` declares
`ProtectedRoles` beside `NonAssignableRoles` with an identical
`map[string]bool` type and a different meaning — "cannot be disabled or
deleted" versus "a person can hold it" — and `member` is in the first. A reader
matching on the type would swap them and empty every picker, so there is an
explicit assertion that `member` never appears in the parsed result.

**Still uncovered, and said out loud rather than left implied.**
`MembershipActionCode`'s nine codes are all really emitted (verified against
`internal/httpapi/`) but the issuer declares them inline at ~20 call sites, so
there is no vocabulary to parse. And the gate compares the SETS the predicates
read, not the predicate LOGIC: the ADR-091 `is_system` exemption and the
ADR-101 absence of an MFA floor are unit-tested, so they would not go red if the
ISSUER changed its mind. Both filed in `TODO.md`.

**Verification.** Red first on both halves. Then three mutations, each caught:
removing `platform_mgmt_api` from the SDK set (red), adding a bogus extra entry
(red — the equality half, which a membership check would have passed), and
pointing the reader at `ProtectedRoles` (red, on the `member` guard). 270 pass /
0 fail / 0 skipped; typecheck, build, taxonomy-parity and changelog-order green.

## 2026-08-30 (ts) — the picker predicate and the server predicate are not the same predicate

**Context.** W1b of the SDK dogfooding refactor: the TypeScript half of the
ADR-081 / ADR-101 D6 predicate port (the WHY of the port itself is the entry
below, written with the Java half — not repeated here), plus the envelope
primitives and the types wave 2 builds transport on.

**The console rule and the server rule are DIFFERENT, and collapsing them was
the trap.** `ui/web/src/roleAssignability.ts` calls one function
`isRoleAssignableTo` and folds four rules into it: the ADR-081 assignability
predicate, the ADR-081 §2.3 human-only floor, a hardcoded
`{owner, platform_api}` exclusion, and a `disabled` check. Only the first two
are `requireRoleAssignableToKind`. The issuer refuses `owner` on the ownership
pointer and `platform_api` on the API-key path — different endpoints, different
errors — and rejects a disabled role as an assignment target elsewhere again.
Shipping one function that means all four would give partners a mirror that can
never be drift-tested against anything, because nothing on the server has that
shape. So: `isRoleAssignableTo` is the EXACT server mirror and is what the drift
gate checks; `isRoleSeatable` adds the two console guards and is what a picker
should call; `rolesAssignableTo` filters with the latter. Naming the seam is the
point — reaching for the server predicate in a picker offers `owner`.

**The console mirror was also missing ADR-091's `is_system` exemption.** The
issuer stopped applying the human-only floor to RI-managed roles when ADR-091
gave `platform_api` realm-control permissions on purpose; without the exemption
the bot role is unassignable to the bot it exists for. The console copy never
learned that. It is a read-time picker so nothing visibly broke — which is
exactly why a hand-maintained copy with no gate rots quietly.

**`confersAuthority` takes the served catalog, closing the divergence Java
filed.** The Go SDK and Java classify a well-formed non-catalog key by its
action while the issuer, which can test catalog membership, calls it conferring.
Rather than embed a catalog copy (the drift-by-copy failure one level down),
`confersAuthority(role, { catalog })` accepts the list `roles.listPermissions()`
already serves and then answers EXACTLY as the issuer does, unknown keys
included. Omit it and you get the action-derived answer. The drift test proves
the two agree on all 31 catalog entries, so the option only ever matters outside
the catalog.

**The role shape is DERIVED from `RoleObject`, never mirrored.**
`AssignableRole = Pick<RoleObject, "name"> & Partial<Pick<RoleObject, …>>`. The
console declared a parallel `AssignableRoleLike` instead, which is the specific
reason ADR-101 removing `required_mfa_methods` produced no compile error and a
dead MFA check sat in a live picker: there was nothing for the compiler to
compare against. Deriving makes the next wire change a type error.

**The drift gate binds twice, and says so when one half cannot.** A pinned
snapshot of the ADR-074 catalog runs everywhere, including a standalone
`Realm-ID/sdk` checkout, and proves the SDK's colon-derived action equals the
issuer's `Action` field for every entry. A second half re-reads the live issuer
source and fails if the snapshot has gone stale. Half two cannot run in this
repo's CI, which checks out one repo — so it emits a diagnostic naming what did
not run, and `REALMID_DRIFT_STRICT=1` turns that into a failure for any runner
that can reach the source. A gate that silently degrades to nothing is the thing
being fixed here; one that announces its own blind spot is not.

**`unwrapData` / `parseErrorEnvelope` become SDK exports, and `http.ts` is their
first consumer.** Four TypeScript copies of the GoFr envelope existed
(web-admin transport, `ui/web/src/api.ts`, `ui/web/src/stepup.ts`, and this
SDK's private `mapErrorResponse`). Exporting without also rewiring `http.ts`
would have made five. There are THREE error shapes, not one, and the third — the
code-less 401 GoFr's own middleware returns for a bad bearer, before any handler
runs — is the one every hand-rolled copy forgets, which is why a retry guard
keyed on a code silently never fires on it. Folding `http.ts` onto the shared
parser also gained it web-admin's `details.server_code` preservation: a code the
`ErrorCode` union does not yet name is still the only thing that tells a caller
which remedy applies, and dropping it turns a specific refusal into a generic
403.

**The membership codes are their own type, NOT additions to `ErrorCode`.**
`membership_not_found` is emitted by the issuer and absent from all three SDK
taxonomies; adding it to TypeScript alone would break
`scripts/taxonomy-parity.py`, which exists precisely to stop one language
drifting. So `MembershipActionCode` (ADR-092 D5) is a separate, narrower union
and the three-language taxonomy fix is filed rather than smuggled. The codes are
contract; the sentences are not — the user-facing strings stay in the
application, because they are product voice and localised, and two consoles will
legitimately phrase `owner_cannot_leave` differently.

**`Permission` becomes `CatalogPermission`, alias kept.** The ADR-074 catalog is
a SERVED contract, so its entry type belongs in the SDK rather than hand-rolled
in `ui/web/src/UserApiKeys.tsx`. The bare name `Permission` reads as "a
permission string" next to `permissions: string[]`; the old name stays as a
deprecated alias so no consumer breaks.

**Verification.** Red first — all three new test files failed before any
implementation existed (233 pass / 3 fail), then 265 pass / 0 fail / 0 skipped,
`tsc --noEmit` clean, `npm run build` clean, and `scripts/taxonomy-parity.py`
still exit 0. The drift gate was mutation-checked: drifting
`HUMAN_ONLY_PERMISSIONS` and drifting the pinned catalog each turned it red on a
different assertion.

## 2026-08-30 (later) — the predicates were written in the console; the issuer is where they are true

**Problem.** `confersAuthority` (ADR-101 D6) and `isRoleAssignableTo` (ADR-081)
existed in exactly two places: the issuer, which enforces them, and
`ui/web/src/roleAssignability.ts`, which is RealmID's own console. Every partner
rendering a role picker has to re-derive both or watch every save come back
`403 role_owner_only` / `400 role_not_assignable_to_kind` — the ADR-090 /
issuer v0.84.0 bug class the console file's own header cites. `RoleScopes`
shipped three-language the same week these were born in a single console.

**Decision.** Ship both as pure predicates in `sdk/java` (`RolePredicates`),
ported from the AUTHORITATIVE Go — `internal/realmrole/{permissions,assignable}.go`
and `internal/httpapi/role_assignable.go` — rather than from the console copy.

**Written WITHOUT a per-role MFA floor, deliberately.** ADR-101 removed
`required_mfa_methods` from the role wire. The console mirror still declares and
CHECKS it, which is inert but false to its own stated contract; porting from the
console would have carried a dead check into three more languages.

**Fail closed on anything unparseable.** A permission is `resource:action`; an
entry with no colon (a legacy free-form string, ADR-074 § Storage) or a null
entry counts as CONFERRING. An entry we cannot read must never be assumed
harmless — the same direction the issuer takes when it classifies every string
outside its catalog as mutating.

**One divergence from the server, stated rather than hidden.** The issuer also
treats a well-formed but NON-CATALOG key (`widgets:read`) as conferring, because
it can test catalog membership. This SDK embeds no catalog copy on purpose —
`roles().listPermissions()` serves it live, so a static copy would be the
drift-by-copy failure one level down — so it classifies such a key by its
action. The case is only reachable for a legacy row (write validation rejects
unknown permissions with `unknown_permission`), and erring toward OFFERING there
is caught by the server, which is the enforcement point.

**A copy needs a gate, or it is the failure mode it was written to fix.**
`RolePredicatesDriftTest` reads the issuer's Go source and compares the
human-only floor set, the `Action != "read"` derivation, the ADR-091 `is_system`
exemption, and the ABSENCE of an MFA floor. It refuses to swallow unparseable
input: a marker it cannot find is a failure, never a pass. Its limit is honest
and filed — `Realm-ID/issuer` is a separate private repo, so the gate runs where
a checkout is on disk and ABORTS with instructions where one is not. That makes
it a local verdict, not a CI one, until the checkout is wired in (`TODO.md`).

**Aligned to the siblings where they had already landed, not re-decided.** The
go and ts ports appeared mid-task; `SYSTEM_UNASSIGNABLE` gained
`platform_mgmt_api` (go had it, and `realmrole.NonAssignableRoles` confirms it —
ts is missing it, filed in `TODO.md`), a null role went from conferring to
conferring-nothing to match both, and the catalog-aware `confersAuthority`
overload mirrors ts's `opts.catalog`. Java keeps go's single-predicate shape
rather than ts's `isRoleAssignableTo`/`isRoleSeatable` split; three languages
with two shapes is filed, not silently resolved by inventing a third.

**Verification.** Red first (the suite did not compile), then green; then five
mutations — fail-open on a colon-less entry, the human-only floor removed, and
the floor set drifted from the issuer — each caught by a different test.


## 2026-08-30 (ADR-101) — the role→scope map is the half that makes the other half worth having

**Problem.** ADR-097 shipped the route→scope half of SDK-side authorization in
three languages: given a token, may this request proceed. The role→scope half —
given the roles a user holds in the partner's product, what scopes should their
token carry — was described in ADR-100 D9 and never built. ADR-101 then removed
the fallback: a partner can no longer author a `realm_roles` row, so "put your
product roles in RealmID" stopped being an option at all.

**Decision.** Ship `RoleScopes` in all three languages, deliberately as a plain
map/record rather than a class or a builder. It is configuration; it should be
readable in a diff; and the entire design intent is that it lives in the
partner's repo as data, next to the roles it describes.

**Fail-closed, and silent — the one judgement call.** A role the map does not
know contributes NOTHING rather than raising. The alternative locks users out of
the partner's product because of a config gap: a role added to their database
before their deploy would fail every login by that user. Refusing a login is a
much worse failure than issuing a token with fewer scopes, which is refused at
the gate with a comprehensible error. `Validate` exists precisely so the gap is
caught at startup instead — and its messages name the map ("role scopes: …"),
because a boot log reader needs to know which of the two scope maps to open.

**Sorted and de-duplicated, not incidentally.** The result is compared, logged
and sent on the wire. An order that depends on map iteration makes two identical
grants look different in a diff, and two roles commonly confer the same scope.

**Three fields left the wire, and the shape is smaller rather than emptier.**
`required_mfa_methods` and `can_invite_roles` are gone from the role object and
both bodies. Keeping them as permanently-empty arrays was rejected: a field that
is always `[]` reads as a capability that exists and nobody uses, which is worse
documentation than its absence. In Java this changes two record arities, which is
a compile error for callers — deliberately, because the alternative is a silently
ignored argument.

**Tradeoff accepted.** A breaking release in all three languages, in the same
cut as the issuer. The SDKs ship FIRST (the ADR-100 D19 order), so a partner can
adopt the new shape before the server stops accepting the old one.

## 2026-08-28 (`realm_id`) — a type-only field, and the pin for it was checked by nothing until it was

`@realm-id/web-admin` `0.9.1` adds `MeMembership.realm_id?: string`, mirroring
issuer spec `0.34.0`: the realm a membership's TENANT LIVES IN, which
`platform_id` does not name on an admin tenant (that one is the realm being
ADMINISTERED; the tenant lives in the base realm, ADR-015).

**Why only this package.** SPEC §13 forces all three language SDKs to move
together for a change that breaks the wire. This one is additive, and more to
the point `go/`, `java/` and `ts/` do not model `GET /me`'s profile shape at
all — grep finds `MeMembership` in exactly one file in this repo. `SPEC.md`
itself specifies the `/me/*` ACTION endpoints and not the profile response, so
the spec is unchanged and there is nothing for the other three to mirror.
Bumping them would publish three no-op releases and make the next reader think
the profile shape lives there.

**Optional, and not for tidiness.** The browser reaches `/me` through a BFF that
DECODES and RE-ENCODES it. A BFF that has not declared the field drops it even
when the issuer sent it, so a client can hold a current SDK and still see
`undefined`. `?` states that honestly; absent means unknown, never "no realm".

**The finding worth more than the field.** The obvious way to pin a type-only
addition is an object literal in a test file. In this package that literal was
checked by NOTHING: `tsconfig.json` excludes `src/**/*.test.ts`, and the runner
is `node --test --import tsx`, which strips types without checking them — the
exact hazard `ci.yml` warns about three lines above the typecheck step, still
open for the test files themselves. A mutation proved it: renaming `realm_id` in
`types.ts` left both `tsc --noEmit` and the suite green.

So `typecheck` now runs a second pass over `tsconfig.test.json`, which includes
the tests. Re-mutated afterwards: three `TS2561`/`TS2551` errors, gate live.

**What that does NOT fix, and it is bigger than this change.** `ci.yml` has jobs
for `go`, `ts` and `java` and NONE for `web/packages/*`. Neither the typecheck
nor the suite of this package runs in CI at all, so the gate above is only as
good as someone running it locally. Filed in `TODO.md`.

## 2026-08-28 (latest) — the enforcement half shipped in three languages and the mint half in none

**Problem.** ADR-097 gave partners an SDK-enforced route-authorization layer —
`ScopesFrom` / `ScopeAllows` / `ScopePolicy` / `ScopeFilter`, shipped in go, ts
and java across `0.47.0` / `0.40.0` / `0.37.0`. That layer evaluates the token's
`scope` claim. **No SDK could put a `scope` on the wire.** The issuer had
accepted the field on `POST /auth/token` the whole time and swagger documented
it, so the feature was reachable only by a partner who bypassed the SDK and
hand-rolled the mint call.

It was found by an integrator, not by us, and the shape of the miss is worth
naming: **we shipped the half of a feature that has tests and skipped the half
that has a caller.** The enforcement layer is pure predicate logic and trivially
unit-testable; the mint half is one field on one request, and nothing in three
suites noticed it was absent, because a body-builder test asserts what the body
contains and never what it lacks.

**Decision 1 — a list in every language, not the wire's string.** The wire is a
single space-delimited string (RFC 6749 §3.3). We could have mirrored that
exactly: `Scope string`. We took `[]string` / `string[]` / `List<String>` in all
three instead.

The reason is not ergonomics. **A space inside one entry is not a parse error on
the wire — it is a silent authority change.** `"orders read"` reaches the issuer
as TWO scopes, and `strings.Fields` splits it without complaint. Mirroring the
string makes the SDK a faithful conduit for a bug the caller cannot see. Taking a
list lets the SDK refuse the entry at the call site, which converts an invisible
privilege change into an error with a stack trace. It also matches the sibling
field `RolePermissions`, which is already a list in all three.

**Decision 2 — validate the charset client-side, never the bounds.** These look
like the same kind of check and are not.

The RFC 6749 §3.3 scope-token charset is **fixed by specification**. A copy of it
in the SDK cannot drift from the issuer's copy without the RFC changing, so
checking it locally is safe forever. The per-realm bounds —
`max_permission_strings`, `max_permission_string_len` — are **realm
configuration**, readable and writable per realm. A client-side copy of those
would drift the first time an operator raised a limit, and would then refuse
requests the server would have accepted: an SDK that is wrong in the direction of
denying legitimate work. So the charset is enforced here and the bounds are the
server's alone.

**Decision 3 — keyed on emptiness, which is the inverse of the field beside
it.** `RolePermissions` is null-keyed: an empty supplied list is a real
instruction there ("this role confers nothing in this org"), and the issuer
answers it with a 403 naming the org, so folding empty into absent would silently
mint the unnarrowed cap.

`scope` is the opposite. `parseScope` trims and returns nil for `""`, so an empty
scope and an absent one are the *same request* — a `"scope": ""` on the wire
could not mean anything. Keying it on nil would put a field on the wire with no
possible meaning. **Two adjacent optional list fields with opposite emptiness
semantics is a genuine hazard**, so both are commented at the call site in all
three languages with the reason, not just the rule.

**Decision 4 — refuse before the request leaves.** The validation runs as the
first statement of `token()`, before headers are resolved and before the platform
bootstrap. A refusal partway through would still have spent the refresh token,
and refresh tokens rotate — so a client-side validation error would have logged
the caller out. That is a worse outcome than the bad scope.

**Tradeoff accepted.** Callers who deliberately want to send a pre-joined string
now cannot. That is the point; the raw `POST /auth/token` remains available and
is documented in the partner guide for anyone who needs it.

**Verification.** Each language got the same three test shapes — the field
reaches the wire space-delimited and in order, empty and absent both omit the
key, and each unsendable entry class is refused with the request never
dispatched. **All three suites were mutation-checked with four mutations each
(drop the field, never refuse, join with a comma, key on nil), and all twelve
were caught.** The first ts mutation run reported blank counts because the dot
reporter emits no summary line; a blank is not a zero.

**Also in this change, same root cause of "documented, never checked":**

- **Four changelog headings named versions that were never tagged** (go
  `0.45.0`/`0.46.0`, ts `0.37.0`–`0.39.0`, java `0.35.0`/`0.36.0`). The partner
  followed them and got 404s. A version number in a changelog is a promise
  someone plans against; ours were written from the version the release train
  *intended* to cut. Corrected against `git tag`, each mapping verified by symbol
  presence and absence at the surrounding tags rather than assumed.
- **`SPEC.md`'s header was pinned to the same phantom train**, so the document
  telling partners which SDK it described named three tags that do not exist.
- **`SPEC.md` never documented `scope` at all**, which is part of why nobody
  noticed no SDK sent it.
- **The ts `test` script was a hand-maintained list of 30 filenames.** A new test
  file is silently never run — the failure mode where a green tick means "did not
  look". It is a filesystem glob now. The list was accurate on the day; that is
  luck, not a design.


## 2026-08-27 (latest) — ADR-100 in four SDKs: making the illegal state unrepresentable in four different type systems

**Problem.** A user API key's authority was expressed by the ABSENCE of a
field. `{ "label": "x" }` — the body every one of these SDKs produced when the
caller named no permissions — minted a key carrying the holder's FULL authority.
That shape was ALSO the only way to ask for an unrestricted key deliberately, so
no server-side check could refuse the accident without refusing the intent. The
fix has to be on the wire, and therefore in every client at once.

**Decision.** `uncapped` is required, and — the part that actually matters —
each SDK expresses "the caller did not say" in its own idiom rather than
defaulting.

- **TS**: `uncapped: boolean`, no `?`, spread UNCONDITIONALLY through a single
  `writeBody()`. A conditional spread is the file's own idiom for every
  neighbouring field, and `false` is exactly what it drops.
- **Go**: `Uncapped *bool` with **no `omitempty`**. Pointer so nil is
  distinguishable; no `omitempty` so nil marshals to JSON `null` and reaches the
  server, which answers `400`. Either half alone would have re-hidden the state.
- **Java**: `UserAPIKeyCreate.of(label)` **deleted**, not adapted. It passed four
  nulls and produced the illegal body; the compile error is the deliverable.
  `capped(label, perms)` and `uncapped(label)` replace it — two factories for two
  states, and no third.
- **web-admin**: nothing, by design. It re-exports and owns no types, and the
  one existing create-body assertion was the right place to pin the new field.

**Options weighed.** A server-side default of `uncapped: false` was rejected:
every existing caller would silently start minting keys that mint nothing, and
the failure would surface at token-exchange time in a different repo. A separate
boolean COLUMN alongside the array was rejected in the ADR for the same family
of reason — two encodings for one idea drift.

**Tradeoff accepted.** Four breaking SDK releases at once, plus a Java
positional record widening that breaks direct `new UserAPIKey(...)` calls. It is
affordable exactly once: prod holds zero user API keys and always has, so no
partner is minting today. That window closes the first time someone does.

**Also deleted: `scopes.remove`** (TS and web-admin; go and java never wrapped
it). Not reduced to one mode — deleted. Retiring a scope is self-healing once
the partner supplies `role_permissions` at every mint: stop emitting the string,
map no route to it, and a stale cap entry never survives an intersection again.
Removing the endpoint also settles the storage CHECK, because nothing is left
that can write an empty cap. Its five tests went with it, and the realm-id-default
test that happened to drive `remove` was re-pointed at `rename` rather than
dropped — it was never about removal.

**What is deliberately NOT cleaned up.** Every SDK still denies on a
PRESENT-but-empty `permissions_cap` claim, a state the issuer can no longer
produce. Each of those assertions now carries a comment saying so, at both ends,
because the next reader will otherwise correctly identify it as dead code and
tidy it away — and it is not dead: it is what a garbled or hostile claim off the
wire lands on, where the only safe reading is "capped to nothing".

## 2026-08-25 (latest) — a changelog can be present and unreachable: the order gate, and the entry that never got its number

**Problem.** `scripts/changelog-hygiene.sh` landed on 2026-08-24 after three
packages silently lost changelog history, and it gates exactly one thing: the
version being published has a `## ` heading. That says nothing about where the
heading SITS. Found by hand on 2026-08-25 while verifying the backfill it
enabled: `ts/CHANGELOG.md`'s `0.36.0` (2026-08-06) sat between `0.29.0` and
`0.28.0`, six releases out of descending order.

**Why that is the same defect and not a cosmetic one.** A reader scanning a
descending changelog stops at the first heading below the version they want. A
heading in the wrong place is therefore invisible in exactly the way a MISSING
heading is — *present and unreachable reads the same as absent* — which is the
fault the script's own header describes at length. It is also why the seven-entry
backfill could only be spot-checked by `grep`: there was no gate to run.

**Decision: an `order` mode, and it runs in `ci.yml`, not in the publishers.**
Placement is the substantive call. The three existing modes fire at publish
time, so `java/CHANGELOG.md` would be order-checked only on a Maven release and
a misplaced heading could sit for weeks. Order is a property of the file at all
times, so it belongs on every push.

**The root `CHANGELOG.md` is deliberately NOT checked, and that was measured
rather than assumed.** Its headings name up to three languages at once
(`… go 0.47.0 · ts 0.39.0 · java 0.37.0`), so there is no single version to
order by — and **15 of its 64 headings carry no date either**, so date order is
not available as a fallback. There is no total order to assert over that file.
Asserting one anyway would mean inventing a rule the file has never followed,
and a gate that fails on correct input teaches people to bypass it — worse than
no gate. Written into the script so the next reader does not "fix" the omission.

**It found a second defect the same minute, one degree worse than the first.**
`ts/CHANGELOG.md` ended with `## Unreleased` — below `0.14.0`, at the bottom of
the file. It is not unreleased: it is a released entry that never got its
number. Identified as **`0.13.0`** on three agreeing pieces of evidence: the
monorepo `CHANGELOG.md`'s *"Go + TS — token manager + refresh_invalid + api-key
DTO (2026-05-28)"* names the release `ts-v0.13.0`; `0.13.0` is absent from the
file, whose lowest entry is `0.14.0`; and the block already sat directly beneath
`0.14.0`, exactly where `0.13.0` belongs.
**One thing does not agree and is left standing rather than smoothed over:** the
draft cites SPEC v0.7.0 while the released entry cites v0.8.0 — a draft written
before the SPEC bump and finished in the other file. The heading takes the
number and date from the released entry; the prose is NOT rewritten to match,
because that would be inventing a record instead of recovering one. The
uncertainty is stated in the entry itself.

**`## Unreleased` is accepted only as the FIRST heading**, which is the
convention it belongs to. Anywhere else it is precisely what it was here.

**Mutation-verified**, not merely observed green: restoring the pre-fix
`ts/CHANGELOG.md` makes the gate name `0.36.0` at its exact line and the
`0.29.0` it sits below.

**A latent defect in `ci.yml` was verified and fixed on the way.** The taxonomy
job's comment says *"`set -e` is deliberately OFF for the run itself"* and then
writes only `set -uo pipefail` — which does not clear the `-e` that a `run:`
step's `bash -e {0}` shell already has in force. Verified, not reasoned:
`bash -e -c 'set -uo pipefail; false; rc=$?; echo reached'` prints nothing. So
on every drift that job has ever detected, the summary it exists to write was
skipped. The gate still failed correctly, which is why nothing ever showed. The
comment described the intent; the code did the opposite. `set +e` added to both
that step and the umbrella's new one.

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

## 2026-09-06 — `sdk/web/packages/*` gain a CI runner (W1-A)

**What.** `.github/workflows/ci.yml` gains a `web` job: checkout, Node 20 (npm
cache keyed on `web/package-lock.json`), `npm ci` in `web/`, `npm run
typecheck` then `npm test`, both via the workspace root's existing
`--workspaces --if-present` scripts — same shape as the `ts` job (typecheck
before the suite, since `node --test` runs each file through `tsx`, transpile
only, no typecheck). `scripts/preflight-check.sh` gained the matching local
gate (loud-skip on missing `web/node_modules`, per the `ts` gate's own
pattern — a skip is not a pass) and `scripts/preflight-parity.sh` gained the
`web:` command pairs so a drift between the workflow and the local script is
caught the same way it already is for `ts`.

**Why.** `sdk/web/packages/{core,admin,bff-realmid,google}` each define a
`test` script and ran NOWHERE — not in CI, not in `make check` — despite
shipping to npm. `react` and `firebase` define no `test` script at all.

**Verified, not assumed.** Ran the new local path for real: `cd web && rm -rf
node_modules && npm ci` (this host's prior `web/node_modules` had a
linux-arm64 esbuild binary left over from an earlier Docker-bound session —
darwin-arm64 tsx/esbuild failed until reinstalled clean, the same class of
trap as the `ui/web` rollup-native-binary issue), then `bash
scripts/preflight-check.sh`: 209 tests across the 4 gated packages (core 90,
admin 96, bff-realmid 11, google 12), all green, typecheck clean across all 6
packages. Also verified fresh in `node:20-bookworm-slim` (mirrors
`ubuntu-latest`) to rule out any host-specific pass. `admin`'s `pretest`
(`npm --prefix ../../../ts run build`) resolves `tsc` even when `ts/`'s own
`node_modules` is absent, because `npm run`'s ancestor-`node_modules/.bin`
PATH augmentation reaches `web/node_modules/.bin/tsc` (hoisted by the `web/`
workspace) — confirmed by moving `ts/node_modules` aside and re-running; the
`web` job therefore needs only `web/`'s own `npm ci`, not a second one in
`ts/`.

**react/firebase — reported, not invented.** Per the plan's own instruction,
no placeholder tests were written for either package. Filed in `sdk/TODO.md`:
both ship to npm gated by nothing.

**Known conflict, left for a human.** `Realm-ID/sdk` PR #2
(`ci/workflow-hygiene-clean`) SHA-pins every action reference in `ci.yml`
(`actions/checkout@v7` → a pinned SHA, etc.) and adds a repo-wide
`defaults.run.shell: bash`. This change adds the `web` job using the
CURRENT unpinned `main` style (`actions/checkout@v7`, `actions/setup-node@v5`)
to match the job it sits beside. The new job is appended after `ts` and before
`java`, so the diffs should not textually conflict on merge — but whoever
lands PR #2 second will need to also pin the `web` job's two action refs, or
the pinning sweep will have missed a job that did not exist when it was
authored.

## 2026-09-06 — a swagger.yaml contract-parity gate, and why the taxonomy gate could never be one (W1-B)

**What.** New `scripts/contract-parity.py` (+ `scripts/contract-parity.test.py`,
run first, per the checker-tests rule) checks request/response field names and
required-ness for five HTTP operations, all three languages, against
`../issuer/docs/swagger.yaml` — the sibling checkout this umbrella workspace
treats as the authoritative HTTP contract. Wired into `make check`
(`scripts/preflight-check.sh`) and `make self-test` (`Makefile`). **NOT**
wired into `.github/workflows/ci.yml` — a different task (W1-A) is live on
that file this session, and this gate needs a sibling `issuer/` checkout that
plain CI (`actions/checkout` on `Realm-ID/sdk` alone) does not have; wiring it
into CI is filed in `sdk/TODO.md` as its own step (composite checkout of both
repos, or a spec artifact copied in).

**Why an across-SDK taxonomy check is not a contract check.**
`scripts/taxonomy-parity.py` compares the three SDKs' error-code lists AGAINST
EACH OTHER. That is a REAL and different question from "do the SDKs match the
server" — it can only ever catch one language drifting from its siblings, by
construction. It cannot catch all three SDKs sharing the same wrong belief
about the server, because there is nothing outside the three for that
agreement to be checked against. That is exactly what happened twice, per
`tests/sdk-e2e/README.md`: every SDK sent a retired `role_id` on
`integrations.install` (issuer required `permissions` since ADR-101 D7 —
every real call 400'd) and TS `listSessions` decoded `{sessions: []}` while
the issuer answers `{items, next_cursor, total}`. Three-way agreement was
maintained the whole time; it was agreement on the wrong thing. Closing that
gap needs a FOURTH party in the comparison — the spec — which is what this
gate adds.

**Scope, deliberately narrow.** Five flat-object contracts: the two the
documented defects touched (`integrations.install`, `integrations.register`),
`auth.listSessions`' response envelope, and two ADR-driven write bodies
(`roleTemplates.create` — ADR-101; `userApiKeys.create` — ADR-100, the
"absent cap meant no restriction" surface). Deliberately does NOT cover
`/auth/login`'s grant-type `oneOf` or `RealmConfigPatch`'s nested JSONB knob
groups — the hand-rolled indentation-based YAML reader (stdlib only, no
PyYAML, matching `taxonomy-parity.py`'s own no-new-dependency shape) can read
a flat `required: [...]` + `properties:` block correctly; forcing it through
a `oneOf` or a multi-level nested object without a real schema library would
either miss real drift or invent it. Widening the contract list one entry at
a time is `sdk/TODO.md`'s job, not a one-shot rewrite into a general parser.

**A missing spec fails LOUDLY (exit 2), never silently.** The spec lives in a
different repo (`issuer/docs/swagger.yaml`, a sibling checkout, not vendored)
— this workspace has repeatedly shipped a gate that went green by not
running (`sdk/TODO.md`'s guards-that-report-nothing lesson;
`todo-ranking-hygiene.py`'s "closure that had not happened"). `check` is
offline by the Makefile's own contract, so the checked-out file is the
source of truth, never the live `GET /.well-known/openapi.json`.

**Verified, not assumed — first run found NO drift** in the five contracts
checked: `python3 scripts/contract-parity.py` exits 0 against the real tree
(`ts`/`go`/`java` all match `swagger.yaml`'s required fields and property
sets, including the two previously-documented defects, which are already
fixed in all three languages). This is a real, checked finding, not an
assumption that the SDKs are clean — the negative test below proves the
mechanism would have caught it had it still been broken.
`scripts/contract-parity.test.py` — 11 assertions, including the load-bearing
negative case: a throwaway fixture reproducing the exact ADR-101 D7 shape
(spec requires `permissions`, a planted TS fixture sends `role_id` instead)
is asserted to report `drift=True` naming that field. A checker that always
says "PARITY" is a scarier bug than the drift it exists to catch.

**No baseline mechanism added.** The brief asked for one only if the first
run's true-finding volume were large enough to need triage; it was not (zero
findings), so none was built. If a future contract addition finds real drift
that cannot be fixed in the same pass, add `EXTRA_OK`-style documented
exceptions (see `taxonomy-parity.py`'s own `EXCEPTIONS` dict for the pattern:
printed every run, never silent) rather than skipping the contract.

# Plan C — SDK: a separate expected issuer (`issuerUrl`), default `baseUrl`

Status: APPROVED 2026-11-03 (owner exited plan mode); building. Original order: "go ahead with the plan".
Source item: `sdk/TODO.md:"Config.BaseURL\` is both the JWKS/issuer fetch URL"`.

## Decision summary (one screen)

- **Problem.** Each SDK uses ONE URL (`baseUrl`) for two jobs: where to FETCH (JWKS, discovery, every API
  call) and what the token's `iss` must START WITH. If a service reaches the issuer on an internal URL
  (`http://api:8080`) while the issuer stamps its public one (`https://api.realmid.local`), every locally
  verified route fails with `401 wrong_issuer`. Prod is unaffected because there the two URLs are equal.
  Today's workaround is the CI overlay `tests/docker-compose.ci.yml` (commit 4cd0550), which moves the issuer's
  `iss` to the internal URL so that the two match.
- **Fix.** Add a new optional config field, `issuerUrl` (Go `IssuerURL`), that defaults to `baseUrl`. Only the
  `iss` checks read it, and every fetch keeps using `baseUrl`. The default leaves behaviour unchanged for
  every existing caller, so this is additive and not a wire break.
- **Where the check lives (verified in source 2026-11-03):**
  - verifier: go `go/verifier.go:147`, ts `ts/src/verifier.ts:139`, java `java/.../verifier/Verifier.java:183`
  - split co-sign expected iss: go `go/trust.go:149` (`expectedIssuer()`), ts `ts/src/split.ts:58-62`,
    java `java/.../split/CoSigner.java` (exact line to be read at build time; UNVERIFIED)
  - fetches that must STAY on `baseUrl`: go `verifier.go:311` (JWKS), `session_peek.go:105` (discovery),
    `http.go`, `passthrough.go`.
- **Recommendations pending the owner's answers (Questions below):** all three languages in lockstep;
  name the field `issuerUrl` / `IssuerURL`; afterwards add BFF env `ISSUER_PUBLIC_URL` and retire the CI overlay
  hack.

## Scope widened by the owner (2026-11-03): "build it" (A) + "C: Fix it all"

- **A, the issuer login-side base-owner filter, is BUILT.** In issuer specs/ADR text: when login offers a
  workspace picker (`tenant_choices`), the base realm's admin tenant is listed only for its owner, matching
  `/me` (`me.go:388`). A brand-new signup holds one membership and never sees the picker, so signup is
  unchanged. If hiding the base tenant leaves exactly one choice, login does not ask for a pick. It proceeds
  with that tenant, the same as a single-membership login. First step: confirm whether the device page's list
  comes from `annotateTenantChoice` (`single_tenant.go:262`) or from `device_grant.go:63`; the filter goes on
  every path that lists workspaces. Red integration test (issuer/test), then the fix. Then R41: persona becomes
  a base owner, `test.fail()` is removed, and a negative test checks that a member is not offered base. After
  that, close the root TODO.
- **B, the console CSP, is ENFORCED** in one go (owner: "Enforce now"). First `npm ci` in Docker to read the
  `@firebase/auth` popup origins from source, then the vitest pin on `public/_headers`, then the header.
- **C now also fixes the side finding.** The SPEC (source of truth) says `iss` must start with
  `${issuerUrl}/${realmId}`. The verifiers check only `${issuerUrl}/`. Before tightening, the builder must prove
  that no SPEC-described flow verifies a token from ANOTHER realm. Candidates: §5's base-realm tokens and ADR-109
  service tokens (SPEC ~1985). If one does, return BLOCKED instead of breaking it.

## Owner answers (2026-11-03)

- Q1: **All three languages ship `issuerUrl` together**, Go, TypeScript and Java, as one SPEC change with matching
  CHANGELOG entries.
- Q2: not asked separately. The plan's default `issuerUrl` / `IssuerURL` stands unless the owner objects.
- Q3: **Yes, the test stack goes back to the realistic shape.** The issuer stamps `https://api.realmid.local`, the
  BFFs fetch `http://api:8080` with `ISSUER_PUBLIC_URL` set, and the CI overlay block from 4cd0550 is deleted.
- Q4: follows Q3, so the BFF env is `ISSUER_PUBLIC_URL` (optional, defaults to `ISSUER_URL`).

## Questions for the owner (as asked)

1. **Languages.** Should this ship Go only, or Go + TS + Java together? Example: a Java partner running inside
   Docker hits the same wall. Recommendation: **all three**. SPEC §13 says the languages ship in lockstep for a
   SPEC change, and the TS and Java checks are the same line.
2. **Field name.** Choose between `issuerUrl` / `IssuerURL` and `expectedIssuer`. The value is a HOST
   (`https://auth.realmid.dev`), not the full `iss`, which is `host/realmId`. Recommendation: **`issuerUrl`**,
   because it mirrors `baseUrl` and does not suggest the full `iss`.
3. **Test stack afterwards.** After the SDK + BFF ship, should the stack switch back to the realistic shape?
   That shape is: the issuer stamps `https://api.realmid.local`, the BFFs fetch `http://api:8080` and set
   `ISSUER_PUBLIC_URL=https://api.realmid.local`, and the three-value CI overlay goes away. Recommendation:
   **yes**. That makes the e2e prove the new field end to end instead of hiding it.
4. **BFF env name** (only if 3 = yes): `ISSUER_PUBLIC_URL`, optional, default `ISSUER_URL`.

Edge cases decided in the plan (tell me if any is wrong):
- E1 A trailing slash is trimmed, exactly as `baseUrl` is.
- E2 A blank or whitespace-only `issuerUrl` counts as unset and falls back to `baseUrl`. A malformed URL is
  NOT validated beyond that, the same as `baseUrl` today.
- E3 The `wrong_issuer` message keeps naming the received `iss`. It does not echo the expected one, the same
  as today.
- E4 The co-signer's expected `iss` (`go/trust.go:149`) also uses `issuerUrl`, because a co-signed token is
  stamped by the same issuer.

Side finding (NOT in scope, goes to `sdk/TODO.md`): SPEC §5 says `iss` must start with `${baseUrl}/${realmId}`,
but all three verifiers check only `${baseUrl}/`. The realm is then parsed out of `iss`. This is a spec/code
divergence. Decide separately whether SPEC or code is right.

## Phases (Doc → Test red → Impl → Release → Consumer)

### Wave 1 — docs (one agent, sdk repo; files: `SPEC.md`, `sdk/DECISIONS.md`, `sdk/CHANGELOG.md`)
- SPEC §1 table: new row `issuerUrl | no | Host the issuer stamps into iss. Default: baseUrl. Set it when
  you reach the issuer on a different URL than it publishes.` §5: `iss` must start with `${issuerUrl}/`.
  §14 (split): the expected iss is `issuerUrl + "/" + realmId`.
- `sdk/DECISIONS.md` dated entry (the why, edge cases E1-E4, the answer to Q1).
- `sdk/CHANGELOG.md` Unreleased entries for go / ts / java.

### Wave 2 — red tests, then impl (three agents in parallel, one per language dir, no shared files)
Each agent works in its own language dir only and gets the same brief:
- RED first, with the failure shown: (a) `baseUrl=http://internal`, `issuerUrl=https://public`, and a token
  with `iss=https://public/<realm>` verifies OK; (b) the same token with `issuerUrl` unset fails `wrong_issuer`
  (the current behaviour, pinned); (c) the JWKS request goes to `http://internal` (a positive control: assert
  the fake server SAW the request); (d) a trailing slash and a blank value (E1/E2); (e) the co-signer's
  expected iss uses `issuerUrl` (E4).
- Impl: Go `Config.IssuerURL` in `go/realmid.go` (defaulting next to the `BaseURL` default at :292), a
  `Realm.issuerURL` field, and `verifier.go:147` + `trust.go:149` reading it. TS `issuerUrl` in the config
  type, `verifier.ts:139` and `split.ts`. Java: a builder field passed into the `Verifier` ctor
  (new overload; keep the old ones) and `CoSigner`.
- Version bumps: go `const Version` 0.73.0 → 0.74.0 (`go/realmid.go:265`), with ts and java minor bumps.
  Run `tag-hygiene` / `changelog-hygiene` locally.
- Gate: `make check` in sdk (or each language's documented gate). Go via `heavy --solo`.

### Wave 3 — release (owner-triggered; "push" never implies release)
- `scripts/release.py sdk go/v0.74.0` (+ `ts-v…`, `java-v…`), then `scripts/release_verify.py`. The go tag
  is immutable, so the tag goes out only after Wave 2 is green.

### Wave 4 — consumer (only if Q3 = yes; api repo + root tests, two agents, file-partitioned)
- api: bump sdk/go to v0.74.0; optional `ISSUER_PUBLIC_URL` → `Config.IssuerURL` in `api/cmd/bff/main.go`
  (next to `ISSUER_URL` :137); a unit test; api DECISIONS + CHANGELOG. This ships through F2 (a root release PR).
- root tests: base compose sets `ISSUER_PUBLIC_URL`, BFF `ISSUER_URL=http://api:8080`, and the issuer keeps
  `https://api.realmid.local`. Delete the three-value block from `tests/docker-compose.ci.yml`. Add a root
  DECISIONS entry that reverses 4cd0550.

## Verification
- Unit: the five tests above, red→green per language (output saved in `.scratch/`).
- E2E (Wave 4): `PW_ARGS=specs/device-approval-v3.spec.ts heavy --max 60m -- tests/support/run-device-e2e.sh`
  locally, plus the release smoke on a runner. Success means the device routes return 200 with the split URLs.
  Before the switch, a deliberately unset `ISSUER_PUBLIC_URL` must show `wrong_issuer` (a positive control
  that the e2e exercises the field).
- Prod: nothing changes (prod leaves `issuerUrl` unset). After the release, `release_verify` per tag.

## Checklist
- [ ] Q1-Q4 answered and written into the SPEC/DECISIONS as sentences
- [ ] W1 docs  - [ ] W2 go  - [ ] W2 ts  - [ ] W2 java  - [ ] side finding filed in sdk/TODO.md
- [ ] W3 tags released + verified (owner ask)  - [ ] W4 api + tests (if Q3) - [ ] close sdk/TODO item
- [ ] copy this plan to `sdk/plans/2026-11-03-sdk-expected-issuer.md` as the first post-approval action

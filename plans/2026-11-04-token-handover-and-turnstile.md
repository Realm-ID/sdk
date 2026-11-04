# Plan — two fixes: SDK `Token()` drops the rotated refresh token (go/ts/java) + Turnstile secret routing (#10)

Status: all four questions answered 2026-11-04; in plan mode until the owner says build.
First post-approval action: copy this plan into `sdk/plans/` and reference it from root `DECISIONS.md`.
Dispatch: Part A = one builder per language (go / ts / java own disjoint dirs; SPEC + docs written
first by the dispatcher); Part B = one builder (root workflow + `api/deploy` + docs). Commit a
`wip/` checkpoint before dispatch; briefs forbid git checkout/restore/stash/reset/clean. Tracks
`sdk/TODO.md:"a hop that ends in an error drops the newer rotated refresh token"` and
`TODO.md:"writes it as a REPO-level secret on Realm-ID/api"` (Next up #6 and #10).

## Decision summary (one screen)

**Part A — SDK (Next up #6).** Bug verified in source in all three languages:
`go/token_lock.go:60-66`, `ts/src/session-lock.ts:283-295`, `java/.../auth/AuthClient.java:539-554`.
`Token` follows up to 3 "hand-overs" (another request already rotated the token; retry on the
NEWER one). If a later hop then errors, the newer token is dropped and the caller keeps the
original, already-SPENT one → its next refresh is `refresh_invalid` → logout. Only the 3-hop
give-up (`RefreshSupersededError` / `RefreshSupersededException`) carries the token, and each
language's TokenManager adopts the token from that type only (`go/token_manager.go:154`,
`ts/src/token-manager.ts:187`, `java/.../TokenManager.java:200`). No consumer outside sdk
(api/cli/ui/web searched — agent finding, not re-checked). SPEC §4.2 (:1407-1434) is SILENT on an
error after a hand-over → this is a spec bug: spec first.

**Part B — Turnstile (#10).** Verified: `ensure-turnstile.yml:131` writes `TURNSTILE_SECRET` as a
REPO secret on `Realm-ID/api` (exists, updated 2026-10-18); `sync-api-secrets.yml` reads only
`api/deploy/secret-keys.txt` (today just `REDIS_PASSWORD`) from Environment `prod` (which has
only `REDIS_PASSWORD`). The release App (`RELEASE_APP_ID` = 5234980 = `realm-id-automation`) has
`environments: write` + `secrets: write`, but the mint step narrows the token to
`permission-secrets` + `permission-actions-variables` only.

## Questions for the owner
(answers written back here as full sentences)

- **Q1 — which errors carry the newer token (owner, 2026-11-04, after a worked example):** Once
  `Token` has followed at least one hand-over, EVERY error it returns carries the newest token it
  held — a lock/store failure, a cancelled context, a wait timeout, a shape-specific 4xx (e.g. a
  403 on a tenant switch), a 5xx or timeout — EXCEPT a token-level error (`refresh_invalid` or any
  401), where that token is known dead and nothing is carried. A hop-0 error is unchanged (the
  caller already holds the token it sent). The rule does not rely on the unverified comment that
  the issuer refuses a 4xx before rotating: the newest token is never worse than the original,
  which is certainly spent.
- **Q2 — API shape (owner, 2026-11-04):** The newer token is carried on a NEW PUBLIC error type in
  every language — Go `*RefreshHandedOverError`, ts `RefreshHandedOverError`, java
  `RefreshHandedOverException` (names proposed) — which wraps the original error, exposes
  `RefreshToken()` / `refreshToken()`, and redacts the token from every print and JSON path the
  way `RefreshSupersededError` does. In Go it `Unwrap`s to the original, so `errors.As` /
  `IsCode` keep matching. In ts and java the THROWN TYPE CHANGES for these failures (a caller's
  `instanceof X` / `catch (XException)` on a post-hand-over error stops matching), so the
  CHANGELOG entry carries a **Breaking** block and the partner docs say how to read the original
  (`.cause` / `getCause()`), plus its code/status copied onto the wrapper. TokenManager adopts the
  token from both the new type and the give-up.
- **Q3 — rotation (owner, 2026-11-04):** The Turnstile secret is rotated ONCE as part of this work,
  after the workflow fix ships, so its value lands in Environment `prod`; each prod dispatch is
  confirmed with the owner first, and the owner signs in once on `app.realmid.dev` as proof.
- **Q4 — sync trigger (owner, 2026-11-04):** Rotation stays a DOCUMENTED TWO-STEP:
  `ensure-turnstile` writes the secret and its run summary tells the operator to run `api`'s
  `sync-api-secrets` within the 2h overlap; no root→api dispatch is added.
- **Q5 — refreshSink fails during adoption (owner, 2026-11-04, option A):** All three TokenManagers
  behave like Go does today, for the 3-hop give-up AND the new hand-over type: the caller gets the
  ORIGINAL error (its code and status unchanged, still carrying the token), with the save failure
  attached to it (Go: in the wrapped message; java: `addSuppressed`; ts: a field on the error).
  ts no longer replaces it with a new `server_error`, and java no longer ignores the failure.
- **Q6 — what "followed a hand-over" means (owner, 2026-11-04):** An error carries a token only when
  the token held at that moment DIFFERS from the one the caller sent. A retry on the same token (a
  non-rotating grant, or a shape-specific stored error) carries nothing, and the thrown type stays
  as it is today. Confirms the SPEC §4.2 text written in sdk `9e958cc`.
- **Q7 — push and release (owner, 2026-11-04):** Once go/ts/java are green and committed, sdk `main`
  is pushed. Then all three are RELEASED (go `0.75.0`, ts `0.62.0`, java `0.59.0`) through
  `scripts/release.py` and proven with `scripts/release_verify.py`. The partner notice to Traide
  about the ts/java Breaking change is DRAFTED for the owner to approve, never sent unattended.
- **Q8 — parked base-realm providers / OTP config (owner, 2026-11-04):** After Part A ships, ONE
  read-only investigation answers both with file:line evidence (does the issuer allow it, does the
  ui hide it) and writes its findings into the root TODO item; nothing is built.

## Part A steps (Design → Doc → Red → Green)
1. **SPEC** `sdk/SPEC.md` §4.2 + §4.2.1: the rule from Q1, the accessor from Q2, TokenManager adopts
   from it.
2. **Docs**: `docs/error-reference.md`; CHANGELOG go `0.75.0` · ts `0.62.0` · java `0.59.0`;
   `sdk/DECISIONS.md` entry with RCA; close the sdk TODO item. Adjacent: `sdk/CHANGELOG.md:16` and
   `ts/CHANGELOG.md:7` still say "unreleased" for releases verified live 2026-11-03 — fix.
3. **Red tests**, per language, beside the existing hop tests (`go/token_lock_round3_test.go`,
   `ts/src/v064-lock.test.ts`, `java/.../V0510FixesTest.java`, reuse `seedSuperseded` /
   `seedHandOvers`): after one hand-over, (a) a lock-store failure, (b) a shape-specific 403,
   (c) a cancelled context each surface the hop-1 token; (d) a `refresh_invalid` surfaces none;
   (e) the error's own code/status/type is unchanged; (f) the token is redacted from every
   print/JSON path; (g) TokenManager adopts + persists it. Confirm each FAILS on today's code.
4. **Implement** go → ts → java; bump `const Version` 0.75.0 (tag-hygiene `unreleased-go`).
5. **Gates**: `make check` per package / `check-all`; no release cut (separate ask).

## Part B steps
1. `ensure-turnstile.yml`: write `gh secret set TURNSTILE_SECRET --env prod --repo Realm-ID/api`;
   add `permission-environments: write` to the mint; update header + summary lines (:6, :200-201).
2. `api/deploy/secret-keys.txt`: add `TURNSTILE_SECRET` (ONLY after it exists in Environment prod —
   else the sync silently takes the repo-level copy) + fix its header comment; same comment in
   `sync-api-secrets.yml:20-22`.
3. Rollout per Q3/Q4, then retire the repo-level copy with a provenance table (owner approves).
4. Docs: `infra/README.md` / runbook line for rotation; root `DECISIONS.md` entry (RCA); close
   the root TODO item.

## Verification
- A: three red→green runs with counts; `check-all` P/N.
- B: `gh api …/environments/prod/secrets` lists TURNSTILE_SECRET; sync run green and `api` on a
  new pinned `api-env:N` revision serving (health body `UP`); a deliberate sign-in on
  `app.realmid.dev` passes Turnstile (positive control — human); repo-level secret gone.

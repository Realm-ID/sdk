# Changelog — `@realm-id/sdk` (TypeScript)

All notable changes to the TypeScript SDK. Ships with a language-prefixed
tag (`ts-vX.Y.Z`). The monorepo-level `../CHANGELOG.md` records
cross-cutting items affecting every SDK at once.

## 0.50.0 — ADR-107 authority propagation, and `last_owner` stops arriving as `conflict` (2026-09-04)

### Added — `AuthorityCache`, a SECOND cache beside the jti denylist (ADR-107)

`RevocationCache` is a jti denylist and can only deny a token the SDK is
HOLDING. An admin demoting a colleague holds neither that colleague's token nor
its jti, so demotion was structurally inexpressible on that key — not merely
missing.

`AuthorityCache` is keyed by `sub` and stores a `notBefore` TIMESTAMP, never a
flag: a flag could not self-heal, and would reject the REFRESHED token too,
locking the user out for the entry's whole TTL. Separate interface rather than a
widened one — adding a method to `RevocationCache` breaks a partner's
implementation SILENTLY at runtime in TypeScript, where a duck-typed object just
lacks the method and demotion never fires.

`realm.notifyAuthorityChanged({subject, intent})` is the one method a partner
calls. `subject` is the `sub` claim — the PER-MEMBERSHIP users-row id, not a
person. `intent` is required and never inferred, since demotion does NOT evict
the session. Calling it with no cache configured is an error, not a no-op.

### Added — `token_stale`, a new 401, and the refresh cap that makes it safe

Distinct from `unauthorized` for the same reason `refresh_invalid` is: a client
that collapses every 401 into "sign the user out" signs people out on
PROMOTION. `isTokenStale(err)` is exported.

The real hazard is a refresh LOOP, not the staleness window: a marker stamped
from the partner's clock against an `iat` from the issuer's turns two seconds of
skew into refresh-fail-refresh from every replica. Two guards — the marker is
stamped 30s early, and `TokenManager.handleStale` refuses to refresh twice for a
token a forced refresh itself produced.

### Fixed — `last_owner` was promised by doc comments and declared by nothing

The issuer returns `409 last_owner` on both owner-protection paths, and two doc
comments named the code. No taxonomy declared it, so it arrived as a generic
`conflict`. Found because a partner's handler "had no `last_owner` case" — the
SDK had never given them one.

### Documented — `LivePermissionResolver` and `capAllows`

A resolver keyed off the token's own claims satisfies the two-operand contract
while making the live operand a function of the stale one. And `capAllows` is a
ONE-operand check on human sessions: `permissions_cap` is minted in exactly one
place in the issuer, so a non-key session never carries one.

## 0.48.0 — the pagination envelope, and the two new input-validation codes (2026-09-03)

### Added — the pagination envelope is no longer discarded, and two new error codes

- **Four list methods returned a bare array and threw the envelope away**:
  `sources.list`, `serviceAccounts.list`, `userApiKeys.list` and
  `apiKeys.list`. They now return the pager, so a caller can page AND detect
  truncation. Every field the issuer's S4/S5/S6 releases added was previously
  discarded before any caller could see it.
- `has_more` is the terminator, **ahead of** `next_cursor`. **Absent is NOT
  false** — it is derived from `next_cursor`, which is correct for every
  endpoint predating the field. Re-encoding pins `has_more: false` as an
  explicit `false`, not a dropped key.
- **New error codes `invalid_cursor` and `invalid_limit`** (issuer `v0.118.x`
  rejects malformed `?cursor=`/`?limit=` with a `400` instead of absorbing it).
  Registered in the taxonomy AND covered by a test asserting the code ARRIVES
  on a decoded error — a registry proves the constant exists, only that proves
  a caller can branch on it.
- Guarded by a **decode → RE-ENCODE round-trip test**. A decode-only assertion
  passes whether or not a field is carried onward, which is exactly how
  `go/v0.53.0` silently deleted `credential_methods`.
- An unset `limit` is OMITTED from the query string rather than sent as
  `limit=0`, which the issuer now rejects. Pinned by a test on the serialised
  URL, not on the intent of the code.

## 0.47.0 — derived claims are resolved at EVERY mint, refresh included (2026-09-01)

### Fixed — `product_roles` and `scope` were resolved on LOGIN LANES ONLY

`mintProductRoles` had exactly three call sites — `login`, `completeLogin`,
`passwordLogin` — and all three are login lanes. The middleware's refresh minted
with `{refreshToken, tenantId, customClaims}` alone, and `token()` forwards only
what it is handed. So a BFF-fronted session carried the claims for one
access-TTL and then lost them for the rest of its life.

- **`product_roles` was silently dropped on every refresh**, while
  `product-roles.ts` promised the opposite in writing the whole time: *"It runs
  on EVERY mint, refresh included, and nothing caches."*
- **`scope` had the same hole with a sharper edge.** The issuer never stores
  `scope` on a session — deliberately, so it cannot go stale — so an unrequested
  claim is an ABSENT one, and `scopesFrom` reads absence as no granted
  authority. A `ScopePolicy` gate therefore begins denying everything one
  access-TTL into every session.

### Added — `scopes` on `createRealm` (`ScopesHandler`, `ScopesError`)

The `scope` twin of `productRoles`: same signature, same retry budget (the
constants are re-exported, not re-declared, so the two cannot drift), same
side-effect-free contract, same "empty result mints no claim" rule. Use it, not
`TokenRequest.scope`, for anything that must reach human sessions — a per-call
field only covers mints a partner writes by hand, and in a BFF deployment the
middleware builds the request itself.

⚠️ Not `realm.scopes` (the ADR-097 §F bulk-rename client) and not `scope.ts`
(the enforcement layer that reads the claim back). Three different things named
after the same claim; this one is the config hook.

### Behaviour change worth knowing

A refresh now costs a SECOND `/auth/token` round trip — **but only when a
handler is configured**. The refresh lane has no user id until a token comes
back (the subject lives in the access token), so the order is mint → read the
subject locally → resolve → re-mint. The peek is a local base64 decode, no JWT
library and no JWKS fetch, over a token the issuer signed and handed back
moments earlier. Consumers who adopt neither handler still mint exactly once,
and a test asserts the COUNT so the extra call cannot creep in unnoticed.

⚠️ **The nil/empty rules across the three claims are NOT uniform, and that is
deliberate.** `product_roles` and `scope` key on EMPTINESS (empty and absent
both mint no claim); `rolePermissions` keys on `undefined`, because an empty
non-nil list is a real instruction the issuer answers with a `403`. Do not
harmonise them.

The new tests are LANE-SPECIFIC on purpose, and they assert the effect ON THE
WIRE rather than that a handler was called: an assertion that "a login carries
the claim" passed throughout the entire life of this bug.

## 0.46.1 — the discovery response carries `credential_methods` (2026-09-01)

### Fixed — the discovery response no longer DELETES `credential_methods`

`IdentityProvidersResponse` had no field for it, in all three SDKs. The
reference BFF does not read discovery — it DECODES the issuer's response into
that type and RE-SERIALISES it to the browser — so the field was dropped in
transit, silently, with no error at any layer.

⚠️ **The effect was that ADR-103/104 credential sign-in was unreachable from
any BFF-fronted console**, which is precisely the failure `credential_methods`
was designed to prevent. The issuer advertised it correctly, `@realm-id/web`
mapped it, `LoginPage` rendered from it — and the SDK in the middle deleted it.

Proven end-to-end against a live stack before and after: straight from the
issuer the response carries `credential_methods: ["password"]`; through the BFF
it was ABSENT.

Every layer's own tests passed over this. The issuer's integration suite
asserts the issuer EMITS it; the console's unit tests assert the screen renders
GIVEN it; nothing asserted it SURVIVES the hop between them. The new guard is a
decode → re-encode round trip rather than a decode-only assertion, because
reading a field back off a struct you just populated passes whether or not the
field is carried onward. Mutation-verified: tagging the field `json:"-"` turns
it red.

Absent still means "the server did not say", never "none" — a second test
asserts an omitted field is not re-emitted as an empty list.

## 0.46.0 — BREAKING: `login` mints, and user API keys lose their org scope

### BREAKING — `login` MINTS now (ADR-102 D10)

Once the tenant is settled, `login` follows `/auth/login` with a `/auth/token`
mint, and the new `productRoles` handler runs there.

- **Single tenant** → mints immediately; one call, as today.
- **Several tenants** → does NOT mint. The tenant list and the refresh token come
  back; your app presents the choice and calls `completeLogin` on selection.
- ⚠️ **Do NOT settle the multi-tenant branch with `selectTenant`.** Its
  `tenants[0]` fallback would mint for an ARBITRARY tenant and resolve THAT
  tenant's roles — a silent wrong answer, not an error.
- **The `412 mfa_required` gate now surfaces from `login`**, where it previously
  surfaced from your own `token()` call. That is the visible half of the change.
- A CHANGED entry point rather than a new one, deliberately: a `loginAndMint`
  would have been non-breaking and would have left the default wrong — every
  consumer who never knew to re-mint keeps the role-blind token.
- **The session `login` created is NOT discarded when the mint fails.** It is the
  recovery anchor: a handler failure is often tenant-specific, so the user can
  choose a different org and mint without re-authenticating.
- **No handler + an access token already in hand costs NO extra round trip**, so
  consumers who never adopt the claim pay nothing.

### Added — `product_roles`, the partner's role NAME on the token (ADR-102)

- A `productRoles` handler `(tenantId, userId) -> string[]`, wired where each
  language wires a realm-level hook (Go a `Config` field, TS a config property,
  Java a `Realm.Builder` method).
- ⚠️ **SIDE-EFFECT FREEDOM IS A CONTRACT.** The SDK calls it an unspecified
  number of times per mint (it retries), so it MUST NOT write, bill, audit or
  emit. A partner logging "role resolved" inside it will see triple entries.
- **No handler → claim omitted, no error.** **Empty or nil → claim omitted, not
  `[]`**: absent and empty must mean the same thing, since every token issued
  before ADR-102 has no claim at all.
- **An error RETRIES (3 attempts, ~50ms then ~150ms) then REFUSES the mint.**
  Minting anyway would say "this principal has no product roles", which is
  indistinguishable from the truth for a principal who genuinely has none — a
  silent under-grant that surfaces as a 403 storm in YOUR product with a 200 in
  our logs. The failure is a distinct SDK error wrapping yours, never a
  `RealmError`: your outage and ours are different incidents.
- It runs on EVERY mint, refresh included. Nothing caches — that freshness is the
  whole advantage over `customClaims`.
- ⚠️ `scope` carries AUTHORITY; this carries a NAME. Do not branch authorization
  on it, and do not confuse it with the `role` claim, which is RealmID's OWN
  vocabulary and a trusted authorization lookup key on the direct-bearer lane.

### Added — cross-language parity that D10 depends on

`needsTenantChoice`, `selectTenant` and `TenantRef.mfaRequired` existed **only in
Go**. A hand-mirrored surface with a hole in it is how the hole survived; D10's
multi-tenant branch depends on all three, so closing the gap was a prerequisite
rather than a tidy-up.

### BREAKING — user API keys are bound to ONE org (ADR-105)

- `orgScope` / `org_scope` and `orgIDs` / `org_ids` are **removed** from the
  write payload, the row shape and the exported types. The row carries `orgId`:
  the minting principal's own tenant, never client-supplied.
- `org_scope: "all"` (every org in the realm the holder belongs to, forward
  inclusive) is deleted along with the realm knobs that gated it.
- A caller needing N orgs mints N keys — strictly better, because revoking one
  then revokes one.
- Measured before deciding: **prod held 0 `user_api_keys` rows**. Zero rows is
  not zero surface, though — the types break.
- ⚠️ The empty-intersection refusal is now **unconditional**: the narrowing used
  to be per-org and the error named which, but a key has one org now and there
  is no "try another org" recovery to point at.

### Added — phone login parity (ADR-103)

- `deliveryMode` accepts `"email"` and `"sms"` alongside `"view_bff"`, with
  constants in all three languages.
- ⚠️ For `purpose=login` the mode decides **who may be authenticated**, not
  merely how the code travels: `view_bff` is read by the PARTNER, so it
  authenticates `kind=service` subjects only; `sms` is read by the SUBJECT, so it
  authenticates any kind; `email` is refused.
- No fallback between the RI-delivered modes.

### Added — native username/password login (ADR-104)

- `passwordLogin` / `PasswordLogin`, taking `identifier` + `presented` +
  optional `tenantId`.
- `identifier` may be an email, an E.164 phone, or a **username**, classified
  ONCE by the issuer.
- ⚠️ **`tenantId` is load-bearing for a username.** Usernames are unique per
  TENANT, not per realm. Explicit wins over the host-derived tenant; neither
  yielding one is `400 tenant_required`, a NAMED code rather than a credential
  failure.
- `403 password_must_change` is NOT collapsed into `invalid_credentials`: the
  password was correct, but an admin set it, so it is an assertion rather than a
  proof.

Spec `0.37.0` → `0.38.0`.

## 0.45.0 — BREAKING: `integrations.install()` sent a field the issuer retired (2026-08-31)

**This call has been returning `400 permissions_required` in production.** The
issuer replaced the install's `role_id` with a STATED `permissions` list: the
install says what the brokered principal may do, rather than naming a role and
inheriting whatever that role grants today.

- **`InstallRequest`: `permissions: string[]` replaces `role_id`.** Required and
  non-empty — an install granting nothing can authorise no call, and ADR-100's
  lesson is that an empty authority field acquires a meaning nobody chose.
- **`Installation` / `InstallResult` carry `permissions`; `role_id` and
  `role_name` are gone from the response too.**
- Error sentinels registered — `permissions_required` (400),
  `unknown_permission` (400), `permissions_exceed_grantor` (403) and
  `install_grants_nothing` (403). Registration is load-bearing: an unregistered
  code collapses to `bad_request`/`forbidden`, so a sentinel without it exists
  and never fires. ⚠️ `install_grants_nothing` is raised at **MINT**, not
  install.
- `role_not_service_typed` / `role_not_installable` are **retained but DEAD** —
  the issuer emits neither since ADR-101 D7. Kept so existing matches compile.
- The old tests asserted the body was `{integration_id, role_id}` and stayed
  green for the whole period the call was failing. The new ones assert
  `permissions` IS sent **and that `role_id` is ABSENT** — presence-only would
  still pass for a client sending both.

## 0.44.0 — the role vocabulary (ADR-101 D1 write side)

- **`realm.roleTemplates`** — RealmID's role VOCABULARY: `list`, `create`,
  `update`, `delete` on `/platforms/{id}/role-templates`. Distinct from
  `realm.roles`: a ROLE belongs to one realm and has holders, a TEMPLATE is the
  recipe a role is stamped from. Base-realm-gated — a partner realm gets
  `role_authoring_retired` on every verb.
- `realms_stamped` on create (a floor template FANS OUT to realms that already
  exist) and `drifted_realms` on update (an edit does NOT propagate, so it
  creates drift by design). **`-1` means the count could not be taken, never
  "none".**
- An unset patch field is OMITTED from the body, never sent as null: absent
  preserves the stored value.
- Exported from `./internal` as well as the root, so `@realm-id/web-admin` can
  build against it.

## 0.43.0 — the SDK carries the shared rules, and the envelope tells the truth (2026-08-30)

The SDK dogfooding refactor: predicates a partner would otherwise re-derive now
live here, and the error envelope stops losing what the issuer stated. Three
defects were fixed that only a consumer could have found — see `DECISIONS.md`.

### Added

- **`isRoleAssignableTo` / `isRoleSeatable` / `rolesAssignableTo` /
  `confersAuthority`** (`roles.ts`) — the ADR-081 assignability and ADR-101 D6
  authority predicates, previously only in the issuer and in RealmID's own
  console. Any partner rendering a role picker had to re-derive both or watch
  every save come back `400 role_not_assignable_to_kind` / `403 role_owner_only`.
  - `isRoleAssignableTo` is the EXACT mirror of the issuer's
    `requireRoleAssignableToKind`, ADR-091's `is_system` exemption included.
  - `isRoleSeatable` adds the two console-side guards the issuer enforces on
    other endpoints (`owner` / `platform_api`, and a disabled role). **Use this
    one in a picker** — the server predicate alone will offer `owner`.
  - `confersAuthority(role, { catalog })` takes the served ADR-074 catalog and
    then classifies identically to the issuer, unknown keys included. Without
    it, the action is derived from the `resource:action` string; the two agree
    on all 31 catalog entries and a drift test proves it.
  - **No per-role MFA floor** — ADR-101 removed `required_mfa_methods` from the
    role wire, and a server still emitting it does not change the answer.
  - `HUMAN_ONLY_PERMISSIONS` (ADR-081 §2.3) and `NON_ASSIGNABLE_ROLES`
    (`realmrole.NonAssignableRoles`) are exported and drift-tested.
  - `AssignableRole` is DERIVED from `RoleObject` via `Pick`, not declared as a
    parallel shape.
- **`unwrapData` / `parseErrorEnvelope` / `ErrorEnvelope`** (new
  `envelope.ts`, exported from both entry points) — the GoFr wire envelope as a
  shared primitive. Handles all THREE error shapes, including the code-less 401
  GoFr's own middleware returns for a bad bearer, which a guard keyed on a code
  never fires on. `HttpClient` now uses them instead of a private copy.
- **`CatalogPermission`** — the ADR-074 catalog entry type
  (`GET /platforms/{id}/permissions`). `Permission` remains as a deprecated
  alias.
- **`SSODomainGrant` + `SSODomainMethod` / `SSODomainStatus` /
  `SSODomainInstructions` / `SSODomainClaimResult` / `SSODomainVerifyResult`**
  (new `sso-domains.ts`) — ADR-094 per-org SSO domain grants. Types only; the
  transport lands in `@realm-id/web-admin`.
- **`MembershipActionCode` / `MEMBERSHIP_ACTION_CODES` /
  `isMembershipActionCode`** (new `memberships.ts`) — the ADR-092 D5
  membership-self-service refusal taxonomy. The codes are contract; the
  user-facing sentences stay in the application.

### Fixed

- **`isRoleSeatable` offered `platform_mgmt_api`.** `NON_ASSIGNABLE_ROLES`
  (formerly the private `SYSTEM_UNASSIGNABLE`) held only `owner` and
  `platform_api`; the issuer's `realmrole.NonAssignableRoles` has a third entry.
  `platform_mgmt_api` is the ONLY identity permitted to mint `platform_api`'s
  key (ADR-091 D3), so a human holding it is a credential-issuance path outside
  the owner pointer — exactly what ADR-101 D6 closes. Ported from
  `ui/web/src/roleAssignability.ts`, which has the same gap. Found by the
  `sdk/java` drift gate, not by this one.
- **The drift gate was green while a set it "guarded" was wrong.** It compared
  the ADR-074 catalog and `HumanOnlyPermissions` and said nothing about the
  other mirrored sets. It now compares EVERY set, by SET EQUALITY rather than
  membership, so an extra entry fails as loudly as a missing one:
  `NonAssignableRoles`, `AssignableKinds`, and the ADR-094
  `tenantdomain.IsValidMethod` / `IsValidStatus` vocabularies. The Go map reader
  is anchored on the variable NAME — `ProtectedRoles` sits beside
  `NonAssignableRoles` with an identical type, a different meaning and `member`
  in it, and reading one for the other would empty every picker.

### Changed

- `PrincipalKind`, `SSODomainMethod` and `SSODomainStatus` are now DERIVED from
  exported const arrays (`PRINCIPAL_KINDS`, `SSO_DOMAIN_METHODS`,
  `SSO_DOMAIN_STATUSES`, plus `SSO_DOMAIN_PROOF_METHODS`). Identical types; the
  arrays exist because a bare union is invisible at runtime, which is another
  way of saying it cannot be drift-tested.
- `HttpClient` now preserves an unrecognised server code under
  `details.server_code` instead of discarding it, matching what
  `@realm-id/web-admin`'s transport already did. A code the `ErrorCode` union
  does not name is still the only thing that says which remedy applies.

## 0.42.0 — ADR-097 mint half: `scope` on the token request (2026-08-28)

**The enforcement half of ADR-097 shipped here in `0.40.0`. The mint half did
not ship at all** — `scopesFrom` / `scopeAllows` / `scopePolicy` /
`createScopeMiddleware` have been evaluating a `scope` claim that this SDK had
no way to put on the wire. The issuer accepted `scope` on `POST /auth/token` the
whole time, so the feature was reachable only by hand-rolling the mint call.
Reported by an integrator.

- **`TokenRequest.scope?: string[]`** — joined into the wire's space-delimited
  string (RFC 6749 §3.3) and sent as `scope` on `POST /auth/token`.
- **An array, not the wire string, on purpose.** A space inside one entry is not
  a parse error on the wire — it SPLITS one scope into two and mints authority
  you did not ask for. An entry outside the RFC 6749 §3.3 scope-token charset is
  refused with `RealmError { code: "bad_request" }` **before the request
  leaves**, so a bad entry never spends and rotates the refresh token.
- **The per-realm bounds are not checked here.** `max_permission_strings` /
  `max_permission_string_len` are realm configuration; a client-side copy would
  drift into refusing what the server accepts. The charset is fixed by RFC and
  cannot.
- **Empty and absent are the same request** — the inverse of `rolePermissions`,
  because the issuer trims and treats `""` as absent, while an empty
  `rolePermissions` is a real instruction answered with a `403`.
- New export: `scopeWireValue`.

Accepted on `/auth/token` only, never `/auth/login`, and it cannot ride in
`customClaims` (`scope` is a reserved claim key). Refused on a service-class
refresh (`400 scope_not_supported`).

Also: the `test` script was a hand-maintained list of 30 filenames, so a new test
file was silently never run. It is a filesystem glob now.

## 0.41.0 — ADR-100: a key's authority is stated, never inferred (2026-08-27)

**BREAKING.** `uncapped` is now required on the user-API-key write schema, and
`scopes.remove` is gone. Unreleased — no tag is cut by this work.

- **`UserApiKeyWrite`** replaces the create-only payload and is shared by
  `create` and the new `update` (ADR-100 D12). `UserApiKeyCreate` remains as an
  alias of it. **`uncapped: boolean` is required and has no default**, and it is
  spread onto the wire UNCONDITIONALLY — `false` is exactly the value a
  conditional spread drops, and dropping it would rebuild inside the SDK the bug
  ADR-100 exists to remove: before this, a body of `{ label }` minted a key
  carrying the holder's FULL authority, so ticking nothing in a console granted
  everything.
- **`userApiKeys.update(tenantId, userId, id, write)`** — `PUT`, sharing the one
  write schema. **It resets what it omits**: change only the cap and the label
  is blanked and the org scope reset. Read-then-write.
- **`auth.login` / `auth.token` accept `rolePermissions`** (wire
  `role_permissions`), the partner's own role→permission list, used to narrow a
  key-derived token's `permissions_cap` claim per org. Optional; omitted means
  unnarrowed. It can only narrow — the claim is `stored_cap ∩ supplied` — so a
  wrong list cannot widen a key. An empty intersection is a `403` naming the
  org, never an empty claim.
- **REMOVED: `scopes.remove`, `ScopeRemoveOnEmpty`, `ScopeRemoveRequest`,
  `ScopeRemoveResult`, `ScopeRemoveEmptiedKey`.** The endpoint was deleted
  outright (ADR-100 D10) — retiring a scope is self-healing now that the partner
  supplies `role_permissions` at mint. `scopes.rename` is untouched.
- `capAllows` still denies on a PRESENT-but-empty claim, and now says why it
  keeps a branch the issuer can no longer reach: a garbled claim off the wire
  must fail closed.

## 0.40.0 — `scopes.remove` (2026-08-25)

Additive. Issuer spec `0.32.0`, ADR-097 §G. **Not published** — CI is down; the
wrapper is written, tested and unreleased.

- **`ScopesClient.remove({ scope, onEmpty?, dryRun? })`** wraps
  `POST /platforms/{id}/scopes/remove`, alongside the existing `rename`.
- **Read its doc comment before calling it.** Removal is not reliably a
  narrowing operation: an empty `permissions_cap` means NO RESTRICTION, so
  removing a key's last scope **uncaps** it. The server refuses by default
  (`scope_removal_would_uncap`, HTTP 409) and writes nothing; `onEmpty:
  "revoke"` removes and revokes in one transaction and must be named.
- `dryRun: true` always answers 200 and is **the only way to obtain the
  `emptied` list** — a refusing write returns 409, whose envelope carries no
  payload.
- `onEmpty` is OMITTED from the body when unset rather than sent as `"refuse"`:
  the server owns the default, and a client hardcoding it would keep sending the
  old one after a server-side change.
- New exported types: `ScopeRemoveRequest`, `ScopeRemoveResult`,
  `ScopeRemoveOnEmpty`, `ScopeRemoveEmptiedKey`.

Suite 221 pass / 0 fail. The path assertion is mutation-verified (re-pointing
`remove` at `/scopes/rename` fails two tests) — a wrapper's entire job is the
path, and the ADR-095 `acceptInvitation` lesson is that one shipped in three
languages with nothing verifying it.

> **Host note:** `npm test` fails on macOS with an `@esbuild/linux-arm64`
> platform error — the `node_modules` tree carries linux binaries from a
> container install over the host mount. Run the suite in Docker
> (`docker run --rm -v "$(pwd)":/w -w /w node:22-alpine npm test`). Same class
> as the rollup binaries issue in `ui/web`, filed in `../TODO.md`.

## 0.39.0 — ADR-097: SDK-enforced route authorization (2026-08-24)

New module `scope.ts`, exported from the package root. Three layers:

- `scopeAllows` / `scopeAllowsAny` / `scopesFrom` — a pure predicate over the
  `scope` claim (RFC 9068 §2.2.3: a space-delimited STRING, not an array). No
  I/O.
- `decideScope` + a `ScopePolicy` route map, `validateScopePolicy` for startup.
  **Denies by default** — a route is made public by SAYING so, never by
  forgetting.
- `createScopeMiddleware` (Express/Connect) and `fastifyScopeHook`. Both typed
  STRUCTURALLY, so neither framework enters your dependency tree.

`Claims` now declares `scope` and `token_class`.

**All-of is the default** on a multi-scope rule; any-of has to be named.
`scopeAllows(claims)` with NO required scopes is **false**, not vacuously true —
"requires nothing" is almost always a route someone forgot to configure.

The 403 carries RFC 6750 §3.1's `insufficient_scope` and deliberately does not
name the missing scopes; they reach your server through `onScopeDenied`.

Seven codes added to the §3.1 taxonomy: `invalid_scope`, `too_many_scopes`,
`scope_too_long`, `scope_not_supported`, `reserved_claim_key`,
`realmid_audience_immutable`, `invalid_rename`.

See SPEC §11, and §11.6 for when to use token scope vs `capAllows` — they trade
per-request I/O against revocation lag, and mixing them without deciding gets
you the worst of both.

## 0.38.0 — BREAKING: `platform_not_found` and `mfa_registration_required` reach `error.code` (2026-08-24)

**BREAKING for anyone matching `not_found` on a platform route.** Both codes are
now in the `ErrorCode` union and `KNOWN_CODES`, so `mapErrorResponse` keeps the
server's specific code instead of falling back to `statusToCode(...)`.

- **`platform_not_found`** — the issuer answers it on every by-id platform route
  (16 call sites). Callers previously saw a generic `not_found` and could not
  tell "no such platform" from any other 404 on the request. **Migration:** match
  both, which is already the idiom for the sibling codes —
  `case "platform_not_found": case "not_found":`. It still never distinguishes
  "not yours" from "never existed"; the issuer answers both identically on
  purpose (`v0.78.0` oracle rule) and that is a security property, not a
  taxonomy one.
- **`mfa_registration_required`** (412) — the first-factor-ENROLLMENT variant of
  the MFA gate, where the remedy is an enrollment screen rather than a code
  prompt. Go has carried it since ADR-061; ts collapsed it into the generic 412
  mapping, losing the distinction for exactly the clients that must render the
  other screen.

`sdk/TODO.md` had recorded the taxonomy as "consistent across the three SDKs,
so no language is the outlier; that is why it reads as intentional and may be."
Measured, it was **eight codes out of sync**. Consistency was never evidence of
intent: the three lists are hand-maintained from one SPEC, so a single omission
propagates identically to all three and agreement is what a shared oversight
looks like. `scripts/taxonomy-parity.py` now measures it on every CI run.

## 0.37.0 — `listSessions` decodes the real envelope; `login({ deviceName })` sends `X-Device-Name` (2026-08-21)

**FIX (user-visible, silent until now): `listSessions` returned an empty array
against every real issuer.** It decoded `{sessions: [...]}`; the issuer answers
the locked paged envelope `{items, next_cursor, total}`
(`httpapi.pagedSlice`), which Go has read all along with `sessions` as an
explicit legacy fallback. A TS consumer's session list was empty and
indistinguishable from "you have no other sessions" — including the
`device_name` label added below. Now reads `items`, keeps `sessions` as a
legacy/mock fallback, and the unit fixture is re-pointed at the shape a real
issuer emits (it had served the invented one, so test and client agreed while
both disagreed with the server). Found by the new `tests/sdk-e2e` suite.

**BREAKING: `listSessions` now returns `Paginated<SessionInfo>`, not
`Promise<SessionInfo[]>` — and it follows `next_cursor`.** Through `0.36.0` it
resolved to a bare array that was the FIRST PAGE ONLY (server default 50), so a
user past that saw a silently truncated list. That is worse than a wrong list on
this surface specifically: a session missing from it is a session the user
cannot revoke, and `listSessions` is what "sign out everywhere" and "revoke that
device" are built on — the controls people reach for when they think they are
compromised.

Parity was the deciding argument, not tidiness. Go returns
`iter.Seq2[*SessionInfo, error]` and Java returns `Paginated<Session>`; TS
already had `Paginated<T>` as exported public API, already used by
`federationBindings.list()`, so the bare array was the odd one out **inside the
TS SDK itself**. The break is loud (a compile error, obvious fix) rather than
the same call quietly returning a different row count.

```ts
// before (0.36.0) — first page only
const list: SessionInfo[] = await realm.auth.listSessions(jwt);

// after (0.37.0) — every session, or one page on request
for await (const s of realm.auth.listSessions(jwt)) { ... }
const first = await realm.auth.listSessions(jwt).page({ limit: 50 });
```

The legacy `{sessions: [...]}` and bare-array tolerances survive as fallbacks.
Neither carries a cursor, so a pre-envelope server yields one page and stops —
it cannot spin the iterator. Verified against a REAL issuer, not only a fixture
(`tests/sdk-e2e`): a new case drives the issuer's own `pagedSlice` with
`limit: 1` so two sessions force a second page, and asserts as a PRECONDITION
that the server emits `next_cursor` at all — without which the paging assertion
would pass vacuously. Both unit tests and the e2e case are mutation-verified.

### `login({ deviceName })` sends `X-Device-Name`

ADR-062's device label was half-implemented in TS: `SessionInfo.device_name`
carried the READ half from the start, and nothing ever SENT the header, so a TS
consumer could display a device label it had no way to set. `sdk/TODO.md`
recorded this gap as Java-only; that was wrong, and it went unnoticed because
the read half is the visible one.

`LoginRequest.deviceName` is optional and rides as the `X-Device-Name` header on
the user grant only — never on the platform bootstrap, which is an M2M mint the
issuer records no device for, and never in the body. Absent means **no header**:
the issuer reads a present empty value as a supplied label. The server caps the
value at 120 chars and strips control characters (`sanitizeDeviceName`), so the
SDK sends it raw.

## 0.36.0 — read one platform's fleet row by id (2026-08-06)

`AdminClient.getPlatform(id)` wraps `GET /admin/platforms/{id}` (issuer
`v0.87.0`, spec `0.24.0`) — the singular counterpart of `listPlatforms`,
returning the identical `PlatformSummary` fleet row for one platform. The
issuer resolves it through the same store query and the same serializer as the
list, so a detail screen built on this cannot disagree with the fleet table.

**Why it matters beyond convenience.** The alternative it replaces is paging
the list and matching client-side, which is bounded by whatever page budget the
caller picks — so a platform past that budget is reported as **not found
although it exists**. The console was doing exactly this with a 20-page cap
(2000 rows), a false negative that arrives on its own as a fleet grows.

*(An earlier draft of this entry said the console rendered such a platform as a
plausible empty one with no error. That was inherited from a stale `ui/TODO.md`
note and is incorrect — the screen has always rendered a "Platform not found"
empty state. Corrected here rather than quietly dropped, since the wrong
description had already been copied into two repos.)*

**A `404` here means "not visible to you" OR "never existed", identically, and
must stay that way.** A platform the caller may not see returns the same
`platform_not_found` as an unissued id — never `403` — because a distinct
refusal would confirm the id is live (issuer `DECISIONS.md` 2026-08-06). Do not
re-label it as a permission error in a consumer: rendering "you don't have
access to this platform" reconstructs the oracle the identical 404 exists to
close.

**Taxonomy note:** `platform_not_found` is not in the curated `ErrorCode`
union (nor Go's, nor Java's), so it normalizes to `not_found` with
`httpStatus: 404`. That is the current contract across all three SDKs;
widening the taxonomy is a lockstep SPEC change, filed in `../TODO.md`.

Additive — no existing behaviour changes.

## 0.35.0 — `me.acceptInvitation`, the mirror of reject (ADR-095 D5) (2026-08-03)

Backfilled 2026-08-25 from commit `1b5e1c0` — see `../CHANGELOG.md`'s matching
entry (go `0.44.0` · ts `0.35.0` · java `0.34.0`) for the full cross-language
writeup; this entry states the TS-specific surface.

`realm.me.acceptInvitation({ tenantId })` wraps `POST
/me/invitations/{tenantId}/accept`, alongside the existing `rejectInvitation`.
Accepts a **pending** invitation: the lifecycle row is stamped `accepted` and
the membership becomes `active`; returns the same `{ tenantId, status }`
envelope as `rejectInvitation`/`leave`, no request body.

Exists because a realm on `invitation_acceptance: "explicit"` (ADR-095 D2,
issuer `v0.82.0`) no longer activates an invitation implicitly at login, so a
decline path with no matching accept path left an invitee able to say no and
unable to say yes.

Errors keep specific codes rather than collapsing into a generic 409:
`not_invited` (already an active member) vs. `not_pending` (already answered,
revoked or expired) — different remedies, only the code tells them apart.
`404` deliberately does not distinguish "no such tenant" from "not yours".

Additive — no existing signature changed. Spec `0.20.0` → `0.21.0`.

## 0.34.0 — BREAKING: `allowedDomains` removed from tenant create (ADR-094 R3) (2026-08-02)

Backfilled 2026-08-25 from commit `5f44408` — see `../CHANGELOG.md`'s matching
entry (go `0.43.0` · ts `0.34.0` · java `0.33.0` · web-admin `0.8.17`) for the
full cross-language writeup.

`tenants.allowed_domains` no longer exists server-side (issuer `v0.77.0`,
migration `1785888000`). `TenantCreate.allowedDomains` is **deleted**; the
create body no longer sends `allowed_domains`. `updateConfig` no longer
honours it either — the server answers `400 unknown_config_key`.

Domains that auto-provision are now `tenant_domains` grants, claimed and
proven through the domains API — a settable allowlist required no proof of
control, which is what let a domain confer access nobody had demonstrated.
Note for migrations: a bulk-imported org therefore starts with its domains
**inert** — there is no bulk-approve path, by design.

Spec `0.17.0` → `0.18.0`.

## 0.33.0 — `withUserToken`: on-behalf-of reaches the typed surface (2026-08-02)

Backfilled 2026-08-25 from commit `398c3ef` — see `../CHANGELOG.md`'s matching
entry (ts `0.33.0` · java `0.32.0`) for the full cross-language writeup.

Additive. No existing method, signature or default changed; a caller that
never calls `withUserToken` sends exactly the bytes it sent before.

A partner BFF acting for a signed-in user must forward that user's verified
access JWT as `X-User-Token` beside the platform bearer (§4, ADR-056) — the
bare `X-On-Behalf-Of-User` id stopped being an identity in issuer `v0.66.0`.
Before this release TS could only send that header on `realm.me.*`; a partner
calling `tenants.list()` on a user's behalf had to drop to raw HTTP.

- **`realm.withUserToken(accessJWT)`** returns a **derived** realm whose every
  call carries the header. The platform token stays the wire bearer — the
  user JWT is additive, never a replacement.
- **Derivation, not a setter** — a settable field on a long-lived realm handle
  would let one request's user leak into the next. The parent's
  platform-token cache, verifier and JWKS cache are shared, so deriving per
  request is cheap.
- **A per-call user token still wins**, and the header is now sent **exactly
  once** — header names are lower-cased on the way in, closing a
  double-header hazard (`fetch` joins same-named headers with a comma, which
  the issuer cannot parse).

189 → 190 tests pass.

## 0.32.0 — membership self-service + the single-tenant picker (ADR-092) (2026-07-30)

Backfilled 2026-08-25 from commit `52f4eb1` (version bump; feature landed in
`eff0322`) — see `../CHANGELOG.md`'s matching entry (go `0.42.0` · ts `0.32.0`
· java `0.31.0`) for the full cross-language writeup.

Purely additive typing of an already-live issuer contract. No existing field,
method or signature changed.

- **`realm.me.*`** gains `chooseTenant` (`POST /me/tenant-choice`),
  `rejectInvitation` (`POST /me/invitations/{tenantId}/reject`), `leave`
  (`POST /me/memberships/{tenantId}/leave`). Authorized by the end user:
  direct (`userBearer`) or BFF (`userToken` → `X-User-Token`). No user-id
  mode.
- **Login response** gains `tenantChoiceRequired` + `tenantChoices[]`
  (`{ tenantId, displayName, isOwner }`). Login still succeeds and still
  returns tokens; the picker is a reconciliation prompt, not an auth failure.
- **`config.get()`** gains `singleTenantPendingReconciliation` — derived,
  read-only. Absent ≠ `0`: reported only while `single_tenant_membership` is
  on.
- **Seven error codes** registered in the taxonomy: `owner_cannot_be_revoked`,
  `single_tenant_not_required`, `not_invited`, `not_pending`,
  `invitations_unavailable`, `owner_cannot_leave`, `already_left`.

## 0.31.0 — BREAKING: the platform session has no refresh token (ADR-089) (2026-07-27)

Backfilled 2026-08-25 from commit `b6c9ad0` — see `../CHANGELOG.md`'s matching
entry (go `0.40.0` · ts `0.31.0` · java `0.29.0`) for the full cross-language
writeup, including the mandatory release-order note.

**Ship this before the issuer deploys `v0.68.0`** — an older SDK *requires*
`refresh_token` in the login response and throws
`"platform login returned empty tokens"` when it's absent, so it fails hard
against a `v0.68.0`+ issuer on the first call. This SDK version works against
old and new issuers alike.

The SDK's platform identity is now an **access token only**. Every
acquisition is a `POST /auth/login` with the bootstrap credential; when the
cached token comes within 30s of expiry, the SDK does that again.
`POST /auth/token` is no longer called for this identity.

- `PlatformTokenManager` loses its refresh-token path; `login` no longer
  requires `refresh_token`; `invalidate()` now clears the whole cached
  session rather than preserving a refresh token.

Why: ADR-089 withdrew the refresh token from every credential-bootstrapped
session — the caller already holds the credential needed to mint a fresh
token, so the refresh token was a strictly weaker duplicate that also
outlived revocation of its source.

Also: `platform_refresh_rotates` is gone from the realm-config surface
(`PATCH /platforms/{id}/config` → `unknown_config_key`).

## 0.30.0 — `admin.userApiKeys` reaches the `/internal` entry point (2026-07-26)

Backfilled 2026-08-25 from commit `a512679` — see `../CHANGELOG.md`'s matching
entry (ts `0.30.0` · web-admin `0.8.14`) for the full writeup.

TypeScript only; no wire change — this exposes a client that already existed.

`UserApiKeysClient` is now re-exported from the `/internal` entry point. It
shipped in `0.29.0` on the public `realm.userApiKeys` facade but never on
`@realm-id/sdk/internal` — the entry `@realm-id/web-admin` builds on — so the
admin surface had no way to reach it. Also newly exported from `/internal`:
`capAllows`, `isUserApiKeyRevoked`, and the `UserApiKey` /
`UserApiKeyCreate` / `OrgScope` / `LivePermissionResolver` types.

## 0.29.0 — admin-key lifecycle: `label` + `expires_at` on list rows (2026-07-26)

Backfilled 2026-08-25 from commit `ffa935c` (ADR-084 user API keys landed
first in `b976e86` on the same version) — see `../CHANGELOG.md`'s matching
entry (go `0.39.0` · ts `0.29.0` · java `0.28.0` · web-admin `0.8.13`) for the
full cross-language writeup.

Tracks issuer `v0.61.0` (ADR-085 §2/§3/§7).

- **`label` on every api-key list row.** The issuer had omitted it, though it
  is the *only* handle on a key — the plaintext is echoed once at create and
  `prefix` is derived from the stored hash.
- **`expires_at` everywhere** (create response + list rows). Nullable, and
  `null` is a value: "never expires", not "unknown".
- **`ttlSeconds` / `nonExpiring` on create.** Omitting both applies the
  issuer's built-in 90-day default; the 300s floor rejects rather than
  clamps.
- **Two new create failures** callers must expect: `too_many_api_keys` (409 —
  a realm holds at most 2 active platform keys) and `non_expiring_not_allowed`
  (400 — at most one permanent key).

Also in this version: ADR-084 user API keys (`uk_live_…`) across the SDK —
`realm.userApiKeys` — the surface `0.30.0` above then re-exported from
`/internal`.

## 0.28.0 — owner-required tenant create + BYO id/created_at (2026-07-24)

`TenantsClient.create` now provisions the org and its owner in one call
(ADR-073 Amendment C, SPEC §6.1). `TenantCreate` gains `owner` (new
`TenantOwner` type — **required on a genuine create**; server returns
`owner_required` otherwise), `id` (bring-your-own tenant UUID, reconciles when
known), and `createdAt` (RFC3339). `ImportUserRow` gains optional `createdAt`
("member since"). Additive wire; the `owner` requirement is the one breaking
change for the create-empty-then-invite flow. See `../CHANGELOG.md`.

## 0.26.0 — role principal typing + invitation scope (2026-07-22)

Types `assignable_to` (ADR-081) and `can_invite_roles` (ADR-076 WP4) on
`RoleObject` / `RoleCreate` / `RolePatch`, plus the read-only
`migrated_holders` / `migrated_holders_to` the issuer returns when a narrowing
PATCH reassigns a role's human holders. New exported `PrincipalKind =
"human" | "service"` union — the server vocabulary is closed, so a typo should
fail at compile time. Additive; no SPEC change. See `../CHANGELOG.md` for the
cross-SDK entry.

## 0.24.0 — ADR-080 Phase B + session-revoke + MFA-self parity (2026-07-20)

Additive parity port of the Go reference SDK (issuer v0.50.0). No SPEC break.

- **Contact-binding (ADR-080 Part 2/3):** `users.delinkContact(tenantId, userId,
  contactId)` and `users.handBack(tenantId, userId, fromUserId)`. `driftReviews.reject`
  is now the SOFT (non-destructive) reject; new `driftReviews.rejectHard` parks the
  account. `DriftRejectResult` reshaped to `{ id, status, mode, parked?, revoked_bindings? }`
  (the old `new_user_id`/`original_value` fields are removed — the reject no longer
  forks a user).
- **Session-revoke (ADR-080):** new `realm.sessions` client — `revokeUser(tenantId,
  userId)` (admin force-logout) and `revokeAll()` (realm-wide mass logout). Distinct
  from `auth.revokeAllSessions` (the caller's own sessions).
- **MFA self-service:** `auth.listAuthenticators()` and `auth.regenerateRecoveryCodes()`
  (the latter may surface `mfa_required` (412) step-up or `conflict`/`not_enrolled`).
- **Error code:** `contact_admin_required` (409) added to the `ErrorCode` union +
  KNOWN_CODES so `isCode()` matches it on login.

## 0.22.1 — fix: auth.login wire body mismatch (2026-07-15)

Bug fix, no SPEC change. `auth.login` was posting
`{ method, provider_token }` — the issuer's `/auth/login` handler reads
`grant_type`/`provider`/`token` and never had a `provider_token` field, so
the provider credential silently never reached the server; `method` rode
the deprecated `legacyMethodToGrant` shim (Sunset 2026-08-01). Now sends
`{ grant_type: "provider_token", provider, token }`, mirroring the Go
reference SDK (`sdk/go/auth.go`). See `sdk/DECISIONS.md`.

## 0.20.0 — service accounts + OTP-login cutover + sources (ADR-071/072) (2026-07-14)

Additive parity port of the go reference SDK (WP6). See `../CHANGELOG.md`.

- **OTP login grant cutover** — `auth.otpLogin` now sends `grant_type: "otp"`
  on `POST /auth/login` (was `method: "otp_internal"`; ADR-071 §4 direct
  cutover, no dual-accept). `auth.mfaVerifyOtp` sends `method: "otp"`.
- **`otp.issue` gains `deliveryMode`** (`"view_bff"`, exported
  `DELIVERY_MODE_VIEW_BFF` / `OtpDeliveryMode`), threaded onto the body as
  `delivery_mode`.
- **`LoginResponse.initiatedByUserId`** — decodes the issuer's
  `initiated_by_user_id` provenance (the owner/admin who minted a service
  account's login OTP, ADR-071 §8).
- **`realm.serviceAccounts`** (new `ServiceAccountsClient`) — `create` / `list`
  / `get` / `resetHandle` / `suspend` / `unsuspend` / `deactivate` / `revoke`
  over `/tenants/{id}/service-accounts`.
- **`realm.sources`** (new `SourcesClient`, ADR-072) — `list` / `create` /
  `update` / `delete` over `/sources`.
- **New error codes** on `RealmError.code`: `handle_taken`, `invalid_role`,
  `service_account_not_found`, `not_service`, `method_violates_kind`,
  `source_not_found`, `user_not_found`.

## 0.19.0 — roles disable/enable + owner signing-keys client (2026-07-13)

Additive. Parity for the issuer v0.32.0 roles/signing-keys overhaul.

- **`RolesClient`** gains `disable(roleId)` / `enable(roleId)`; `RoleObject`
  gains `disabled` / `disabled_at`; `RoleListOpts` gains `includeSystem`
  (→ `?include_system=true`).
- **`SigningKeysClient`** (new, `realm.signingKeys`) — `list()` returns the
  keyring + rotation policy (`{ keys, rotation }`); `rotate()` self-serve
  rotates and returns `{ kid, retired_kids }`. Owner-scoped
  (`/platforms/{id}/signing-keys`).
- **`TenantConfigPatch`** — typed `updateConfig` body for the org-governance
  keys (`role_overrides`, `default_invitation_role`).
- Re-exported from `@realm-id/sdk/internal` for `@realm-id/web-admin`.

## ts-v0.18.0 — `idle_ttl` on login + token responses (ADR-070, 2026-07-10)

Additive. `LoginResponse` and `TokenResponse` now carry `idleTtl?` (wire
`idle_ttl`, seconds) — the sliding-window idle-timeout **duration** for the
session (ADR-070). `undefined`/`0` means no idle timeout; the BFF reads it to
enforce a per-realm idle window. Cut in lockstep with the go + java SDKs
(`../CHANGELOG.md` / `../DECISIONS.md` 2026-07-10). Version/tag picked centrally.

## 0.17.0 — `refresh_exp` on login + token responses

Additive. `LoginResponse` and `TokenResponse` now carry `refreshExp?` (wire
`refresh_exp`, unix seconds) — the refresh token's absolute expiry (SPEC §4.1).
`undefined` against a pre-refresh_exp issuer; consumers sizing a session from it
must fall back to a local ceiling. Cut in lockstep with go/v0.26.0 +
java-v0.15.0 (`../CHANGELOG.md` / `../DECISIONS.md` 2026-07-09).

## 0.16.1 — decode session last-used from `last_seen_at`

Fix. `listSessions` cast raw server JSON with no snake→camel mapping, so
`SessionInfo.lastUsedAt`/`createdAt` were never populated. Realigned the
`SessionInfo` interface to the issuer wire shape (`last_seen_at`, `created_at`,
`origin`, `device_name`; int64 unix seconds). Cut in lockstep with go/v0.25.1 +
java-v0.14.1 (`../CHANGELOG.md`).

## 0.16.0 — IdP provider `config` on the admin write surface

Additive. Mirrors the monorepo lockstep entry (`../CHANGELOG.md`, cut with the
Go + Java SDKs). `identityProviders` create/update now carry a `config` object
(provider-specific settings — e.g. Microsoft tenant/authority, Google hosted
domain) alongside the existing `type` / `client_id` fields, so a platform owner
can configure an IdP row's provider settings through the SDK rather than only
issuer-side.

## 0.15.0 — Refresh-authed MFA self-enrollment (ADR-061)

Breaking. Mirrors the monorepo lockstep entry (`../CHANGELOG.md`, cut with
`go/v0.18.0` + `java-v0.13.0` + web bff-realmid 0.3.3).

### Changed (breaking)
- `auth.selfEnrollMfa({ refreshToken, tenantId, method? })` replaces
  `enrollMfa` + `confirmMfa`. Posts to `POST /auth/mfa/enroll` and returns
  `{ secret, qrUrl, recoveryCodes, mfaChallengeToken, tenantId }`. The
  enroll-scoped `mfaChallengeToken` is completed via `mfaVerify` — one
  verify confirms the new secret **and** mints tokens. `enrollMfa`,
  `confirmMfa`, and `ConfirmMfaRequest` are removed; `MfaEnrollment` gained
  `mfaChallengeToken` + `tenantId`.

### Known issue
- `recoveryCodes` are returned but not yet redeemable (no issuer redemption
  path); do not present them as a recovery mechanism until the follow-up
  ships.

## 0.14.0 — workload identity federation (2026-06-02)

Additive (non-breaking). Implements SPEC v0.10.0 §4.0.1 (ADR-057).

### Added
- `CredentialSource` abstraction for the platform-session bootstrap, plus
  built-in sources `staticApiKey`, `googleWorkloadIdentity`,
  `githubActionsOidc`, and a zero-config auto-detect.
- `RealmConfig.credential` to pin a source explicitly. `RealmConfig.apiKey`
  is now sugar for `staticApiKey(apiKey)` and **optional** — when both are
  unset the SDK auto-detects an ambient workload identity (GCP / GitHub
  Actions) and exchanges its OIDC token via
  `grant_type=urn:ietf:params:oauth:grant-type:token-exchange`.

## 0.13.0 — token manager + `refresh_invalid` + api-key DTO (2026-05-28)

**Heading recovered 2026-08-25; the body below is the original draft, unedited.**
It sat as `## Unreleased` at the BOTTOM of this file — a released entry that
never got its number — until `scripts/changelog-hygiene.sh order` flagged it.
The identification rests on three things that agree: the monorepo
`../CHANGELOG.md`'s *"Go + TS — token manager + refresh_invalid + api-key DTO
(2026-05-28)"* names this release **`ts-v0.13.0`**; `0.13.0` is absent from this
file, whose lowest numbered entry is `0.14.0`; and the block already sits
directly beneath `0.14.0`, which is exactly where `0.13.0` belongs.

**One thing does NOT agree and is left as it stands:** this draft cites
**SPEC v0.7.0** while the released monorepo entry cites **v0.8.0**, which reads
like a draft written before the SPEC bump and then finished in the other file.
The number and date are taken from the released entry; the prose is not
rewritten to match, because that would be inventing a record rather than
recovering one.

Additive (non-breaking surface) plus one wire-shape correction on
`apiKeys`. Mirrors the Go SDK and SPEC v0.7.0 §3.1 / §4.2.1 / §6.5.

### Added

- **Token manager** (SPEC §4.2.1): `realm.auth.newTokenManager(refreshToken,
  { tenantId?, refreshSink?, clock? })` returns a `TokenManager` for
  long-lived single-identity clients (desktop apps, sync agents, daemons)
  that hold one refresh token. `accessToken()` returns a cached token while
  it has ≥60s of life, otherwise mints a new one via `POST /auth/token`.
  Concurrent `accessToken()` calls single-flight onto one shared in-flight
  refresh (one-time-use refresh tokens must never be presented twice in
  parallel). The optional `refreshSink` is awaited with
  persist-before-return semantics: the rotated refresh token is committed to
  memory first, then handed to the sink; only if the sink resolves is the
  new access token cached and returned. A `refresh_invalid` response is
  terminal — surfaced verbatim, never retried or fallen back on.
- **`refresh_invalid` error code** (SPEC §3.1): added to the `ErrorCode`
  taxonomy and the HTTP error decoder's known-code allowlist, so a server
  `refresh_invalid` (returned by `POST /auth/token` when the refresh token is
  expired, revoked, or reuse-detected) is surfaced as
  `RealmError({ code: "refresh_invalid" })` rather than a generic
  `unauthorized`.

### Changed

- **`apiKeys` DTO alignment** (SPEC §6.5, issuer-authoritative — "code
  wins"): `ApiKey` now mirrors the issuer `APIKey` / `APIKeyListItem` wire
  shapes. Create returns `{ id, value, scope, label }` (the one-time secret
  is `value`, **not** `secret`); list rows are `{ id, prefix, role,
  created_at, last_used_at, revoked_at }` (`role` is a singular string,
  **not** a `scopes` array; the `*_at` fields are unix-seconds numbers,
  with `last_used_at` / `revoked_at` nullable). `ApiKeyCreate` is now
  `{ scope, label? }` (**not** `displayName` / `scopes`). `list()` accepts
  the issuer `{ items, next_cursor, total }` envelope and tolerates a flat
  array or legacy `{ api_keys }` envelope. Added `isApiKeyRevoked(key)`
  helper (mirrors Go's `APIKey.Revoked()`).

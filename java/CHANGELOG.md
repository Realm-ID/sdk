# Changelog — `dev.realmid:sdk` (Java)

All notable changes to the Java SDK. Ships with a language-prefixed tag
(`java-vX.Y.Z`). The monorepo-level `../CHANGELOG.md` records cross-cutting
items affecting every SDK at once.

## 0.47.1 — issuer v0.121.0's two role-template seat-check codes, plus `overrideSeated` overloads (2026-09-05)

### Documented — `role_template_seated` / `role_template_seat_check_failed`

Issuer v0.121.0 added two refusals on `PATCH`/`DELETE
/platforms/{id}/role-templates/{templateId}`, and they are NOT interchangeable:

- `role_template_seated` (409) — principals are currently seated at this
  template; the write was refused. RECOVERABLE — retry with
  `?override_seated=true` (audited).
- `role_template_seat_check_failed` (503) — the seat count could not be TAKEN
  at all ("could not tell" must not read as "none"). ⚠️ UNCONDITIONAL: unlike
  `role_template_seated`, `override_seated=true` does NOT rescue it — there is
  no count to override, only an inability to compute one.

Neither code joins the general `ErrorCode` union — matching the existing
`role_template_exists` / `role_template_not_found` / `role_authoring_retired`
family, none of which is registered there either, in any of the three SDKs. A
caller reads the raw code from `exception.getDetails().get("server_code")`,
the same seam `ErrorEnvelopeTest` already exercises for `role_owner_only`.
`RoleTemplatesClient.update`/`.delete` document both codes and the override
distinction in Javadoc; two new tests in `RoleTemplatesClientTest` assert the
codes arrive via that existing fallback. No functional change — the generic
unknown-code handling already carried them.

### Added (same-day follow-up, owner ruling) — `overrideSeated` overloads

An SDK must not report an error whose stated remedy is unreachable through
it: `role_template_seated` names `?override_seated=true` as its remedy, and
until this addition nothing in the Java SDK could send it.
`update(String, RoleTemplatePatch, boolean)` and `delete(String, boolean)`
overloads were added, mirroring `RolesClient.delete(String, String
migrateTo)`'s existing convention of a delegating short overload. The
existing `update(String, RoleTemplatePatch)` and `delete(String)` signatures
are unchanged and now delegate to the new overloads with `false` — no
existing call site breaks. Sent ONLY as `override_seated=true`; the issuer
accepts no other value as meaningful, so `overrideSeated=false` and the
delegating short overload both produce the identical wire request (parameter
absent). Does **not** rescue `role_template_seat_check_failed` (503) — that
refusal stays unconditional, and the Javadoc says so beside the flag.
`updateSendsOverrideSeatedOnlyWhenRequested` and
`deleteSendsOverrideSeatedOnlyWhenRequested` confirmed red first (compile
failure against the pre-change signatures), full `./gradlew build` green.

## 0.47.0 — ADR-041's revocation cache finally lands in Java, plus ADR-107 (2026-09-04)

### Added — `RevocationCache`, which Java never had

go and ts shipped ADR-041's jti denylist with that ADR. **Java shipped
nothing**, so a Java partner had no stop-the-bleed between "the user clicked
logout" and the access token's stateless natural expiry — up to
`access_ttl_seconds`, 900s by default — and nothing in the API said so.

It stayed invisible because nothing failed, the interface was absent from every
place rather than one, and `TokensClient.isRevoked` sits one package away doing a
different job. It surfaced only because ADR-107's rationale asserted that
widening this interface would break Java silently — an argument about a thing
that was not there.

`dev.realmid.sdk.revocation.{RevocationCache, MemRevocationCache}`, consulted by
the verifier after signature and claim checks and BEFORE the ADR-107 authority
check. Fails closed. `Realm.builder().revocation(...)`; `logout` pushes the jti
when `LogoutRequest.accessToken` is set, best-effort by design.

The tests assert the CONSULTATION, not the cache, verified by mutation: stubbing
the verifier's branch fails them. A published interface the verifier never reads
would be worse than the honest absence.

### Added — `AuthorityCache` + `token_stale` (ADR-107)

Subject-keyed staleness marker storing a `notBefore` timestamp, beside the jti
denylist rather than replacing it. `Realm.builder().authority(...)`,
`realm.notifyAuthorityChanged(new AuthorityChange(sub, Intent.DEMOTED))`, and
`ErrorCode.TOKEN_STALE`. `TokenManager.handleStale` caps the forced refresh at
once per token — the loop-breaker.

### Fixed — `ErrorCode.LAST_OWNER`

The issuer's `409 last_owner` was named by doc comments and declared by no
taxonomy, so it reached callers as a generic `conflict`.

## 0.45.0 — the pagination envelope, and the two new input-validation codes (2026-09-03)

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

## 0.44.0 — derived claims are resolved at EVERY mint, refresh included (2026-09-01)

### Added — `Realm.Builder.scopes(ScopesHandler)`

The `scope` twin of `productRoles(ProductRolesHandler)`. It resolves the
PARTNER's own ADR-097 scope strings for a principal in one org and the SDK mints
them onto the access token's `scope` claim, SPACE-DELIMITED on the wire.

Same contract as `ProductRolesHandler`, deliberately: side-effect freedom is
required (the SDK retries, so the handler must be a pure read), the retry budget
is the SHARED one — 3 attempts, ~50ms then ~150ms — and an empty or null result
mints NO claim rather than an empty one. A handler failure REFUSES the mint as a
`ScopesException`, which is deliberately NOT a `RealmException`: "your scope
handler failed 3 times" and "RealmID refused your mint" are different incidents
and must not look alike in your logs.

⚠️ **The empty rule is NOT uniform and must not be harmonised.** `productRoles`
and `scope` key on EMPTINESS; `rolePermissions` keys on NULL, because an empty
non-null list is a real instruction ("this role confers nothing here") that the
issuer answers with a 403.

⚠️ **Use the handler, not `TokenRequest.scope`, for anything that must reach
human sessions.** The per-call field only covers mints you write by hand; in a
BFF deployment `RealmFilter` builds the request itself, so the per-call field
never reaches the lane humans actually use.

### Fixed — `product_roles` and `scope` were dropped one access-TTL into every session

`AuthClient.mintProductRoles` had two call sites, `login` and `completeLogin`,
and BOTH are login lanes. Nothing resolved on refresh: `RealmFilter.handleRefresh`
minted with `new TokenRequest(candidate, tenantId, custom, null)` alone. So a
BFF-fronted session carried `product_roles` for one access-TTL and then lost it
for the rest of its life — while `ProductRolesHandler` promised in writing that
it "runs on EVERY mint, refresh included, and nothing caches".

`scope` had the same hole with a sharper edge. The issuer NEVER stores `scope`
on a session (deliberately, so it cannot go stale), so an unrequested claim is an
ABSENT one and `Scopes.scopesFrom` reads absence as no granted authority — a
`ScopePolicy` gate therefore starts denying EVERYTHING about one access-TTL into
every session.

`RealmFilter`'s refresh lane now resolves both. The order is mint → read the
`sub` from the returned access token LOCALLY (no network, no verification round
trip) → resolve → re-mint against the ROTATED refresh token, because the refresh
lane has no user id until a token comes back.

**The second round trip is OPT-IN with the feature**: with no handler registered
the refresh mints exactly ONCE, and a test asserts the mint COUNT rather than
just the body. It is also skipped when both handlers return nothing, since the
re-mint could only reproduce the token already in hand.

### Added — `AuthClient.enrichRefreshMint(TokenResponse, String)`

The seam `RealmFilter` calls. Public because Java has no cross-package internal
visibility, and useful directly if you run your own refresh lane.

⚠️ **`TokenManager` is deliberately NOT enriched**, matching the Go SDK. It is
the single-identity daemon lane, where the caller holds one refresh token
out-of-band; the derived claims belong to the human-session lane the middleware
fronts. If you want them there, call `enrichRefreshMint` yourself.

### Compatibility

Source- and binary-compatible. `AuthClient` gains a 5-argument constructor and
keeps the 3- and 4-argument ones; `Realm.Builder` gains `scopes(...)`; no record
component and no canonical constructor changed.

## 0.43.1 — the discovery response carries `credential_methods` (2026-09-01)

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

⚠️ `IdentityProvidersResponse` is a record, so its canonical constructor
gains a component. Deserialisation is unaffected; code CONSTRUCTING one
directly (test doubles, fakes) must pass the new argument.

## 0.43.0 — BREAKING: `login` mints, and user API keys lose their org scope

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

## java-v0.42.0 — BREAKING: `integrations.install()` sent a field the issuer retired (2026-08-31)

**This call has been returning `400 permissions_required` in production.** The
issuer replaced the install's `role_id` with a STATED `permissions` list: the
install says what the brokered principal may do, rather than naming a role and
inheriting whatever that role grants today.

- **`InstallRequest`: `permissions` (`List<String>`) replaces `roleId`.**
  Required and non-empty — an install granting nothing can authorise no call.
- **`InstallResult` / `Installation` carry `permissions`; `roleId` and
  `roleName` are gone from the response too.**
- ⚠️ All three are **records**, so the positional constructor arity changes —
  a caller using the canonical constructor will not compile until updated.
- Error sentinels registered — `permissions_required` (400),
  `unknown_permission` (400), `permissions_exceed_grantor` (403) and
  `install_grants_nothing` (403). Registration is load-bearing: an unregistered
  code collapses to `bad_request`/`forbidden`, so a sentinel without it exists
  and never fires. ⚠️ `install_grants_nothing` is raised at **MINT**, not
  install.
- `role_not_service_typed` / `role_not_installable` are **retained but DEAD** —
  the issuer emits neither since ADR-101 D7. Kept so existing matches compile.

## java-v0.41.0 — the role vocabulary (ADR-101 D1 write side) (2026-08-30)

- **`realm.roleTemplates()`** — RealmID's role VOCABULARY: `list`, `create`,
  `update`, `delete`. Distinct from `realm.roles()`: a ROLE belongs to one realm
  and has holders, a TEMPLATE is the recipe a role is stamped from.
  Base-realm-gated — a partner realm gets `role_authoring_retired` on every verb.
- `RoleTemplateCreated.realmsStamped()` (a floor template FANS OUT to realms
  that already exist) and `RoleTemplatePatched.driftedRealms()` (an edit does
  NOT propagate, so it creates drift by design).
  **`driftUnknown()` / `orphanCountUnknown()`** exist so that `-1` — "the count
  could not be taken" — survives as a boolean instead of being re-derived, and
  is never read as "none".
- A null field in `RoleTemplatePatch` is OMITTED from the request body, never
  sent as null: absent preserves the stored value.

## java-v0.40.0 — the two role predicates every console re-derives (2026-08-30)

Unreleased — no `java-v*` tag is cut by this work.

- **New `dev.realmid.sdk.roles.RolePredicates`** — `confersAuthority(RoleObject)`
  / `confersAuthority(List<String>)` (ADR-101 D6) and
  `isRoleAssignableTo(RoleObject, String kind)` (ADR-081), plus the
  `KIND_HUMAN` / `KIND_SERVICE` constants and the `SYSTEM_UNASSIGNABLE` /
  `HUMAN_ONLY_PERMISSIONS` sets they read. Predicate parity with go and ts —
  the same tier `RoleScopes` shipped at.
- **`confersAuthority(List<String>, Collection<Permission>)`** — pass the realm's
  SERVED ADR-074 catalog (`roles().listPermissions()`) and the answer matches
  the issuer exactly, including its fail-closed verdict on a grant string the
  catalog does not name. Without a catalog the `resource:action` split decides,
  which agrees for every catalog entry. No catalog is embedded in the SDK: a
  static copy would be the drift-by-copy failure one level down.
- **Nothing here is a security control.** The issuer enforces both rules and
  answers `403 role_owner_only` / `400 role_not_assignable_to_kind`; these exist
  so a console never OFFERS a choice whose every save 403s.
- **Authority is derived from the GRANTS, never from the name** — any grant
  whose action is not `read`. An unparseable entry (no colon, or null) FAILS
  CLOSED and counts as conferring.
- **No per-role MFA floor.** ADR-101 removed `required_mfa_methods` from the
  wire, so there is nothing role-level left to evaluate; the realm and tenant
  MFA policies are untouched and are not this class's business.
- **`RolePredicatesDriftTest` reads the issuer's own Go source** and fails when
  the copy drifts. It needs a `Realm-ID/issuer` checkout (`../../issuer`, or
  `-Drealmid.issuerDir` / `REALMID_ISSUER_DIR`) and cannot run in this repo's CI
  yet — filed in `../TODO.md`.

## java-v0.39.0 — ADR-097 mint half: `scope` on the token request (2026-08-28)

**The enforcement half of ADR-097 shipped here in `java-v0.37.0`. The mint half
did not ship at all** — `Scopes` / `ScopePolicy` / `ScopeFilter` have been
evaluating a `scope` claim that this SDK had no way to put on the wire. The
issuer accepted `scope` on `POST /auth/token` the whole time, so the feature was
reachable only by hand-rolling the mint call. Reported by an integrator.

- **`TokenRequest.withScope(List<String>)`** — a sixth record component, joined
  into the wire's space-delimited string (RFC 6749 §3.3) and sent as `scope` on
  `POST /auth/token`. The previous 5-arg constructor is retained, so existing
  callers compile unchanged.
- **A list, not the wire string, on purpose.** A space inside one entry is not a
  parse error on the wire — it SPLITS one scope into two and mints authority you
  did not ask for. An entry outside the RFC 6749 §3.3 scope-token charset is
  refused with `RealmException(BAD_REQUEST)` **before the request leaves**, so a
  bad entry never spends and rotates the refresh token.
- **The per-realm bounds are not checked here.** `max_permission_strings` /
  `max_permission_string_len` are realm configuration; a client-side copy would
  drift into refusing what the server accepts. The charset is fixed by RFC and
  cannot.
- **Empty and absent are the same request** — the inverse of `rolePermissions`,
  because the issuer trims and treats `""` as absent, while an empty
  `rolePermissions` is a real instruction answered with a `403`.
- New API: `Scopes.wireValue(List<String>)`.
- `TokenRequest.withRolePermissions` now calls the canonical 6-arg constructor.
  The 5-arg compat form compiles there just as well and would have silently
  dropped `scope`.

Accepted on `/auth/token` only, never `/auth/login`, and it cannot ride in
`customClaims` (`scope` is a reserved claim key). Refused on a service-class
refresh (`400 scope_not_supported`).

## java-v0.38.0 — ADR-100: a key's authority is stated, never inferred (2026-08-27)

**BREAKING.** Unreleased — no `java-v*` tag is cut by this work.

- **`UserAPIKeyWrite` replaces `UserAPIKeyCreate`, which is DELETED**, and with
  it `UserAPIKeyCreate.of(label)`. That factory passed four nulls and produced
  `{"label": "…"}` — the exact wire shape ADR-100 makes illegal, because it used
  to mint a key carrying the holder's FULL authority. The compile error is the
  point. Two named factories replace it: `UserAPIKeyWrite.capped(label, perms)`
  and `UserAPIKeyWrite.uncapped(label)`.
- `uncapped` is put on the body UNCONDITIONALLY, unlike every neighbouring
  field — a null travels as JSON null and earns a loud `400`.
- **`userApiKeys().update(tenantId, userId, id, write)`** — `PUT`, sharing the
  one write schema. **It resets what it omits.**
- **`LoginRequest` / `TokenRequest` gain `rolePermissions`** (wire
  `role_permissions`), with `withRolePermissions(...)`; the pre-ADR-100
  constructors are kept so existing arities still compile.
- `UserAPIKey.uncapped()` on the response record — a positional widening, so
  direct `new UserAPIKey(...)` calls need the extra component.

## java-v0.37.0 — ADR-097: SDK-enforced route authorization (2026-08-24)

New package `dev.realmid.sdk.scope`. Three layers:

- `Scopes.scopeAllows` / `scopeAllowsAny` / `scopesFrom` — a pure predicate over
  the `scope` claim (RFC 9068 §2.2.3: a space-delimited STRING, not an array).
- `ScopePolicy` + `ScopeRule` — a route map that **denies by default**, with
  `validate()` for startup.
- `ScopeFilter` — a servlet `Filter`.

**Why a servlet Filter and not a Spring component.** This SDK's only web
dependency is `jakarta.servlet-api`, declared `compileOnly`. Spring MVC and Boot
both run on servlets, so a Filter works there with no new dependency — whereas a
Spring-native `HandlerInterceptor` would put Spring into the dependency graph of
every partner using this SDK, including those who do not use it.

**Java makes one mistake unrepresentable that Go and TypeScript only validate.**
`ScopeRule`'s factories mean a public rule cannot carry scopes at all — a
compile error here, a startup diagnostic there. Pinned by
`publicRuleCannotAlsoCarryScopes`.

Seven codes added to the §3.1 taxonomy: `INVALID_SCOPE`, `TOO_MANY_SCOPES`,
`SCOPE_TOO_LONG`, `SCOPE_NOT_SUPPORTED`, `RESERVED_CLAIM_KEY`,
`REALMID_AUDIENCE_IMMUTABLE`, `INVALID_RENAME`.

See SPEC §11, and §11.6 for token scope vs `capAllows`.

## java-v0.36.0 — BREAKING: `platform_not_found` and `mfa_registration_required` resolve (2026-08-24)

**BREAKING for anyone matching `NOT_FOUND` on a platform route.** Both are now
`ErrorCode` constants, so `fromWire` resolves them and `mapErrorResponse` keeps
the specific code instead of falling back to `fromHttpStatus`.

- **`PLATFORM_NOT_FOUND`** — answered by the issuer on every by-id platform
  route. **Migration:** match both `PLATFORM_NOT_FOUND` and `NOT_FOUND`. It
  still never distinguishes "not yours" from "never existed" (issuer `v0.78.0`
  oracle rule) — a security property, not a taxonomy one.
- **`MFA_REGISTRATION_REQUIRED`** (412) — the first-factor-ENROLLMENT variant of
  the MFA gate; the remedy is an enrollment screen, not a code prompt. Go has
  had it since ADR-061.

See `../CHANGELOG.md` for why the taxonomy was eight codes out of sync across
the three languages, and `../scripts/taxonomy-parity.py`, which now measures it
on every CI run.

## java-v0.35.0 — the ADR-041 realm pin, and the ADR-062 device label (2026-08-21)

Two cross-language parity gaps, both closed against the Go and TS
implementations rather than re-derived.

**`PlatformTokenManager` performs the ADR-041 client-side realm pin.** It
decodes the platform access token it has just minted — no signature check; it
arrived from RI over TLS and verifying it is `Verifier`'s job — and refuses a
token whose `iss` does not reference the configured realm, with
`ErrorCode.REALM_MISMATCH`. Java had carried that constant since the taxonomy
parity pass and never performed the check, so the confused-deputy case (SDK
built for realm A, API key belonging to realm B) surfaced as a cryptic 4xx on
whichever management call happened to run first, or not at all.

A token whose payload cannot be decoded is deliberately **not** a mismatch —
the pin answers "which realm is this token for", and an unreadable answer is
left to the verifier. Mirrors Go (`checkIssuer` returns nil on a malformed
payload) and TS (peek returns `""` → skip).

New constructor overload takes the realm id; the 7-arg constructor is kept and
**skips** the pin, exactly as TS skips it when no `realmId` is configured.
`Realm.builder()` passes the realm id, so the pin is on by default for every
partner-built client.

**`LoginRequest.deviceName` → the `X-Device-Name` header (ADR-062).** Sent on
the user grant only, never on the platform bootstrap, and never in the body.
The issuer caps it at 120 chars and strips control characters, so nothing is
sanitized client-side. `Session` gains the matching `deviceName()` accessor for
the `listSessions` row — the field the session list has been serving since
ADR-062 while `@JsonIgnoreProperties(ignoreUnknown = true)` silently swallowed
it.

The SDK strips what an HTTP header field value cannot carry (C0 controls and
DEL) before sending — the JDK's `HttpRequest.Builder.header` refuses such a
value, so a label containing a newline failed the whole login rather than
arriving sanitized. The 120-char cap stays server-side; the stripped value is
byte-identical to what the server would have stored. An all-control label sends
no header at all.

**Verified against a real issuer**, not only a fake server: `tests/sdk-e2e/java`
compiles against this source tree and drives a live stack (label round-trip,
header-not-body placement, the split sanitizing, and the realm pin firing
against the issuer's actual `iss`).

**Source-compatible.** `LoginRequest` gains a fourth record component with a
3-arg constructor kept for existing callers; `Session` gains a component, which
is source-incompatible only for code calling its canonical constructor
positionally (no first-party caller does).

## java-v0.34.0 — `me().acceptInvitation`, the mirror of reject (ADR-095 D5) (2026-08-03)

Backfilled 2026-08-25 from commit `1b5e1c0` — see `../CHANGELOG.md`'s matching
entry (go `0.44.0` · ts `0.35.0` · java `0.34.0`) for the full cross-language
writeup; this entry states the Java-specific surface.

`realm.me().acceptInvitation(tenantId, auth)` wraps `POST
/me/invitations/{tenantId}/accept`, alongside the existing `rejectInvitation`.
Accepts a **pending** invitation: the lifecycle row is stamped `accepted` and
the membership becomes `active`; returns the same `{tenantId, status}`
envelope as `rejectInvitation`/`leave`, no request body.

Exists because a realm on `invitation_acceptance: "explicit"` (ADR-095 D2,
issuer `v0.82.0`) no longer activates an invitation implicitly at login, so a
decline path with no matching accept path left an invitee able to say no and
unable to say yes.

Errors keep specific codes rather than collapsing into a generic 409:
`not_invited` (already an active member) vs. `not_pending` (already answered,
revoked or expired). `404` deliberately does not distinguish "no such tenant"
from "not yours".

Additive — no existing signature changed. Spec `0.20.0` → `0.21.0`. 185 tests
pass.

## java-v0.33.0 — BREAKING: `TenantCreate.allowedDomains` removed (ADR-094 R3) (2026-08-02)

`tenants.allowed_domains` no longer exists server-side (issuer `v0.77.0`). The
record component is deleted, and with it the
`of(String displayName, List<String> allowedDomains, TenantOwner owner)`
overload. **Source-incompatible** for callers of that overload or of the 6-arg
canonical constructor — the constructor is now 5-arg
`(id, displayName, signupMode, createdAt, owner)`.

Domain SSO is a proven `tenant_domains` grant claimed through the domains API,
not a field on create; a settable allowlist needed no proof of control.

## java-v0.29.1 — docs: `invalidate()` no longer describes the withdrawn refresh step (2026-07-27)

**No behaviour change.** `PlatformTokenManager.invalidate()`'s javadoc still said
"the refresh token is preserved so the next `getToken()` can try `/auth/token`
before a full re-login" — describing a mechanism ADR-089 removed in `0.29.0`, and
contradicting the ADR-089 note 40 lines above it in the same class. There is no
refresh field in `PlatformTokenManager`; `invalidate()` forces a re-mint from the
bootstrap credential, which is the only acquisition path.

Published as a patch release rather than folded into the next feature release so
the javadoc on Maven Central stops describing a call the SDK cannot make. The
class's runtime behaviour in `0.29.0` was already correct — a `0.29.0` user needs
no upgrade for correctness, only for accurate documentation.

Monorepo `../SPEC.md` carried three instances of the same staleness (§6's
"refreshes via `POST /auth/token`", the auth-header section listing a platform
refresh token as a legal bearer, and a §4 contrast against "a dead platform
refresh"); all four are corrected together. See `../DECISIONS.md` (2026-07-27).

## java-v0.27.0 — owner-required tenant create + BYO id/created_at (2026-07-24)

`realm.tenants().create(...)` now provisions the org and its owner in one call
(ADR-073 Amendment C, SPEC §6.1). `TenantCreate` is re-shaped to
`(id, displayName, allowedDomains, signupMode, createdAt, owner)` with new
`of(displayName, owner)` / `withId(...)` / `withCreatedAt(...)` factories; the
new `TenantOwner` record (`ofEmail`/`ofPhone`/`ofUserId`) seats the owner and
is **required on a genuine create** (server returns `owner_required`
otherwise). `ImportUserRow` gains a trailing `createdAt` ("member since").
Breaking for direct `new TenantCreate(...)` callers (arity change) and for the
create-empty-then-invite flow. See `../CHANGELOG.md`.

## java-v0.25.0 — role principal typing + invitation scope (2026-07-22)

Types `assignable_to` (ADR-081) and `can_invite_roles` (ADR-076 WP4) on
`RoleObject`, `RoleCreate` and `RolePatch`, plus the read-only
`migratedHolders` (boxed `Integer`, so absent stays null) / `migratedHoldersTo`
returned by a narrowing PATCH. Both records grew their canonical constructors;
the previous arities are retained as delegating constructors, so existing
positional callers still compile. New `RolePatch.onlyAssignableTo` /
`.onlyCanInviteRoles`. Additive; no SPEC change. See `../CHANGELOG.md`.

## java-v0.23.0 — ADR-080 Phase B + session-revoke + MFA-self parity (2026-07-20)

Additive parity port of the 8 backend surfaces shipped in issuer v0.50.0
(already reachable via the BFF `/api/*` passthrough). Mirrors the Go reference
SDK (`sdk/go/{drift_reviews,sessions,user_binding,mfa_recovery}.go`).

- **New error code** `CONTACT_ADMIN_REQUIRED` (`contact_admin_required`, login
  409) — the ADR-080 Phase B new-provider approval gate. The flat error
  envelope `{ "error": "<msg>", "code": "<code>" }` now surfaces the `error`
  string as the exception message (previously left as a stray detail); the
  top-level `code` was already decoded.
- **`tenants().users().delinkContact(tenantId, userId, contactId)`** (ADR-080
  Part 2) → `DelinkContactResult{status, contactId, revokedBindings}`.
- **`tenants().users().handBack(tenantId, userId, fromUserId)`** (ADR-080
  Part 3) → `HandBackResult{status, userId, email}`.
- **`tenants().driftReviews().rejectHard(tenantId, reviewId)`** — hard reject
  (parks the account). `reject(...)` (soft) is unchanged. `DriftRejectResult`
  reshaped to `{id, status, mode, parked, revokedBindings}` — the pre-ADR-080
  `newUserId`/`originalValue` fields are **removed** (compile-break for any
  caller that read them; the old wire fields no longer exist).
- **New `sessions()` client** — `revokeUser(tenantId, userId)` (member force
  logout) and `revokeAll()` (realm-wide mass logout, targets the SDK's own
  realm) → `SessionRevokeResult{status, revoked}`. Owner/admin
  (`sessions:revoke`).
- **`auth().listAuthenticators(req)`** → `AuthenticatorList{authenticators[],
  backupCodesRemaining}` and **`auth().regenerateRecoveryCodes(req)`** →
  `RecoveryCodes{status, recoveryCodes[]}` (409 `not_enrolled`, 412
  `mfa_required` step-up). Dual-mode bearer trio like `disableMfa`.

Backend-only backing; no SPEC change. See `../CHANGELOG.md` + `../DECISIONS.md`.

## java-v0.22.0 — fix: tenants().create route + body alignment (2026-07-16)

Source-breaking fix. `tenants().create` posted to `POST /tenants` with
`{display_name, owner_user_id?, config?}` — no such route exists (404 against
the live issuer), and neither `owner_user_id` nor `config` is accepted on
create. Now issues the contract call `POST /platforms/{realmId}/tenants` with
`{display_name, allowed_domains?, signup_mode?}`, matching SPEC §6.1 / swagger
and the Go + TS SDKs. `TenantCreate` is now `(displayName, allowedDomains,
signupMode)` — the removed `ownerUserId`/`config` accessors are a compile-break
for any caller that set them (the old call could never have succeeded).
Ownership is set via the seat/invite path + `PUT …/owner`; per-tenant config via
`PATCH …/config`. Two pinning tests guard the route/body + the retired keys.
See `../DECISIONS.md`.

## java-v0.21.0 — parity batch: S-03/04/05/06/07 + WP6 (2026-07-15)

Additive parity port (changelog backfill — the tag shipped without an entry).
`users.importUsers` (S-03, ADR-073), `tenants.updateUserRole` (S-04), IdP
discovery surface (S-05), federation-bindings client (S-06, ADR-057), list
filters `role`/`status`/`q` + invitation status (S-07), owner-transfer optional
params (WP6, ADR-076). See git log + `../CHANGELOG.md`.

## java-v0.20.1 — fix: AuthClient.login wire body mismatch (2026-07-15)

Bug fix, no SPEC change. `login()` was putting `method`, `token`, AND a
redundant `provider_token` — the issuer's `/auth/login` handler reads
`grant_type`/`provider`/`token`, never `provider_token`, and `method` rode
the deprecated `legacyMethodToGrant` shim (Sunset 2026-08-01). Now puts
`{ grant_type: "provider_token", provider, token }` only, mirroring the Go
reference SDK (`sdk/go/auth.go`). See `sdk/DECISIONS.md`.

## java-v0.20.0 — roles: required_mfa_methods write surface (ADR-075) (2026-07-15)

Additive port of the go/ts surface. See `../CHANGELOG.md`.

- **`RoleObject.requiredMfaMethods()`** decodes the role's ADR-075 MFA method set
  (`required_mfa_methods`, subset of `{"totp","otp"}`).
- **`RoleCreate` / `RolePatch` gain a `requiredMfaMethods` component**, forwarded
  as `required_mfa_methods` on create/patch. Back-compat constructors preserved
  (the 3-arg `RoleCreate` and 2-arg `RolePatch` still compile);
  `RolePatch.onlyRequiredMfaMethods(...)` added.
- No breaking change; the platform `mfa_policy` config key rides the generic
  realm-config PATCH (no new typed method).

## java-v0.19.0 — roles: listPermissions + delete migrate_to (ADR-074) (2026-07-14)

Additive port of the go/ts surface. See `../CHANGELOG.md`.

- **`roles().listPermissions()`** returns the live ADR-074 catalog
  (`GET /platforms/{id}/permissions`) as `List<Permission>`
  (`Permission{key, resource, action, label}`).
- **`roles().delete(roleId, migrateTo)`** overload forwards `?migrate_to=<name>`
  to reassign an in-use role's holders server-side instead of a 409.
- No breaking change; `RoleObject.permissions()` already existed.

## java-v0.18.0 — service accounts + OTP-login cutover + sources (ADR-071/072) (2026-07-14)

Additive parity port of the go reference SDK (WP6). See `../CHANGELOG.md`.

- **OTP login grant cutover** — `auth().otpLogin(...)` now sends
  `grant_type=otp` on `POST /auth/login` (was `method=otp_internal`; ADR-071 §4
  direct cutover, no dual-accept). `auth().mfaVerifyOtp(...)` sends `method=otp`.
- **`otp().issue(...)` gains delivery mode** — `OtpIssueRequest` gains a
  `deliveryMode` component (+ `withDeliveryMode(...)` and
  `DELIVERY_MODE_VIEW_BFF`), threaded onto the body as `delivery_mode`. The
  back-compat 5-arg constructor is preserved.
- **`Session.initiatedByUserId()`** — decodes the issuer's
  `initiated_by_user_id` provenance (ADR-071 §8).
- **`realm.serviceAccounts()`** (new `ServiceAccountsClient`) — `create` /
  `list` / `get` / `resetHandle` / `suspend` / `unsuspend` / `deactivate` /
  `revoke` over `/tenants/{id}/service-accounts`.
- **`realm.sources()`** (new `SourcesClient`, ADR-072) — `list` / `create` /
  `update` / `delete` over `/sources`.
- **New `ErrorCode` constants**: `HANDLE_TAKEN`, `INVALID_ROLE`,
  `SERVICE_ACCOUNT_NOT_FOUND`, `NOT_SERVICE`, `METHOD_VIOLATES_KIND`,
  `SOURCE_NOT_FOUND`, `USER_NOT_FOUND`.

## java-v0.17.0 — roles disable/enable + owner signing-keys client (2026-07-13)

Additive. Parity for the issuer v0.32.0 roles/signing-keys overhaul.

- **`RolesClient`** gains `disable(roleId)` / `enable(roleId)`; `RoleObject`
  gains `disabled()` / `disabledAt()`; `RoleListOpts` gains `includeSystem`
  (`RoleListOpts.includingSystem()`, → `?include_system=true`).
- **`SigningKeysClient`** (new, `realm.signingKeys()`) in package
  `dev.realmid.sdk.signingkeys` — `list()` returns `SigningKeysResponse`
  (`keys` + `rotation`); `rotate()` returns `RotateSigningKeyResult`
  (`kid` + `retiredKids`). Owner-scoped (`/platforms/{id}/signing-keys`).
- Per-tenant `updateConfig` already accepts an arbitrary config map — no
  change needed for `role_overrides` / `default_invitation_role`.

## java-v0.16.0 — `idle_ttl` on login + token responses (ADR-070, 2026-07-10)

Additive. `Session` and `TokenResponse` gain `idleTtl` (wire `idle_ttl`,
seconds, `long`) — the sliding-window idle-timeout **duration** for the session
(ADR-070). `0` means no idle timeout; the BFF reads it to enforce a per-realm
idle window. Cut in lockstep with the go + ts SDKs (`../CHANGELOG.md` /
`../DECISIONS.md` 2026-07-10). Version/tag picked centrally.

## 0.15.0 — `refresh_exp` on login + token responses

Additive. `Session` and `TokenResponse` gain `refreshExp` (wire `refresh_exp`,
unix seconds, `long`) — the refresh token's absolute expiry (SPEC §4.1). `0`
against a pre-refresh_exp issuer. Cut in lockstep with go/v0.26.0 + ts-v0.17.0
(`../CHANGELOG.md` / `../DECISIONS.md` 2026-07-09).

## 0.12.0 — workload identity federation (2026-06-02)

Additive (non-breaking). Implements SPEC v0.10.0 §4.0.1 (ADR-057).

### Added
- `CredentialSource` + `Credential` and the `CredentialSources` factory
  (`staticApiKey`, `googleWorkloadIdentity`, `githubActionsOidc`,
  `autoDetect`) for the platform-session bootstrap.
- `Realm.Builder.credential(...)` to pin a source explicitly.
  `Builder.apiKey(...)` is now sugar for `staticApiKey` and **optional** —
  when neither is set the SDK auto-detects an ambient workload identity
  (GCP / GitHub Actions) and exchanges its OIDC token via
  `grant_type=urn:ietf:params:oauth:grant-type:token-exchange`.

## 0.11.0 — OTP surface parity + MFA-verify wire fix (2026-05-29)

Closes the two cross-language drifts where Java trailed Go (`go-v0.15.0`)
and TS (`ts-v0.13.0`): the entire OTP surface was missing, and MFA verify
sent the wrong wire field.

### Fixed

- **MFA verify wire field (breaking against a live issuer).** `mfaVerify`
  sent `challenge_token`; the issuer requires `mfa_challenge_token`
  (`MFAVerifyRequest required: [mfa_challenge_token, code]`). Go/TS were
  already correct. Every Java `mfaVerify` call previously 400'd. A new
  `AuthClientTest` body-assertion locks the field name.

### Added

- **OTP surface (SPEC §X)** — new `dev.realmid.sdk.otp` package: `OtpClient`
  (`issue` → `POST /auth/otp/issue`, `view` → `GET /auth/otp/{id}`,
  `verify` → `POST /auth/otp/verify`), wired as `realm.otp()`. Supports the
  dual-mode bearer trio (`userBearer` legacy / `userId` BFF +
  `X-On-Behalf-Of-User`), matching Go's `OTPClient`.
- `AuthClient.otpLogin(...)` (`POST /auth/login` with `method=otp_internal`)
  and `mfaVerifyOtp(...)`.
- Six OTP `ErrorCode`s: `INVALID_OTP`, `OTP_EXPIRED`, `OTP_LOCKED`,
  `OTP_NOT_FOUND`, `INVALID_PURPOSE`, `INVALID_SUBJECT_REF` (wire strings
  match Go/TS; decoded from nested `error.code`).
- Tests: `OtpClientTest` (8) + OTP cases in `AuthClientTest`. Full suite 100/100.

## 0.10.0 — token manager + refresh_invalid + api-key DTO + ADR-051 (2026-05-28)

Brings the Java SDK to parity with Go (`go-v0.15.0`) and TS (`ts-v0.13.0`)
for SPEC v0.8.0. Additive on the public auth surface, with one wire-shape
correction on `apiKeys` and the ADR-051 platform-auth migration (the latter
fixes a hard break against issuer ≥ v0.7.0).

### Added

- **Token manager** (SPEC §4.2.1): `realm.auth().newTokenManager(refreshToken)`
  / `newTokenManager(refreshToken, new TokenManagerOptions().tenantId(…)
  .refreshSink(…).clock(…))` returns a `TokenManager` for long-lived,
  single-identity clients (desktop apps, sync agents, daemons) that hold one
  refresh token. `accessToken()` returns a cached token while it has ≥60s of
  life, otherwise mints a new one via `POST /auth/token`. Concurrent
  `accessToken()` calls single-flight onto one shared in-flight refresh
  (one-time-use refresh tokens must never be presented twice in parallel —
  reuse-detection). The optional `RefreshSink` is invoked with
  persist-before-return semantics: the rotated refresh token is committed to
  memory first, then handed to the sink; only if the sink returns normally is
  the new access token cached and returned (a sink that throws fails the
  acquisition). A `refresh_invalid` response is terminal — surfaced verbatim,
  never retried or fallen back on. Thread-safe.
- **`REFRESH_INVALID` error code** (SPEC §3.1): added to the `ErrorCode` enum.
  The HTTP error decoder already reads the issuer's nested
  `{"error":{"code":…}}` envelope, so a server `refresh_invalid` (returned by
  `POST /auth/token` when the refresh token is expired, revoked, or
  reuse-detected) now surfaces as `RealmException` with
  `getCode() == ErrorCode.REFRESH_INVALID` rather than the generic
  `UNAUTHORIZED`.

### Changed

- **api-key DTO aligned to the issuer (code wins)** (SPEC §6.5): `APIKey` now
  mirrors the issuer `APIKey` / `APIKeyListItem` wire shapes. List rows are
  `{ id, prefix, role, createdAt, lastUsedAt?, revokedAt? }` — `role` is a
  singular string (**not** a `scopes` array), and the `*At` fields are
  unix-seconds `Long`s (`lastUsedAt` / `revokedAt` nullable). Create returns
  the row plus a one-time `value` secret (**not** `secret`). `APIKeyCreate`
  is now `{ scope (required), label? }` (**not** `displayName` / `scopes`).
  Added `APIKey.revoked()` helper (mirrors Go's `APIKey.Revoked()`).
  **Breaking** for any caller that read the prior `displayName` / `scopes` /
  `secret` / string-timestamp fields.
- **ADR-051 platform-auth migration**: `PlatformTokenManager` no longer calls
  the removed `POST /auth/platform-token` (hard-cut server-side in v0.7.0).
  It now bootstraps the SDK's platform session via the two-endpoint flow —
  `POST /auth/login {grant_type:"platform_api_key", api_key}` for the initial
  mint, `POST /auth/token` (refresh token as bearer) to refresh, falling back
  to a fresh login on a 401. The public surface (`getToken()`, `invalidate()`)
  is unchanged; `invalidate()` now preserves the refresh token so the next
  acquire prefers `/auth/token` before a full re-login. `auth().login()` now
  also sends the `token` field (alongside the legacy `provider_token`) to
  match the issuer's `loginReq.Token`. The raw API key only ever travels on
  the first `/auth/login` call.

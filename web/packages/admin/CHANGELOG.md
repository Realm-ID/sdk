# @realm-id/web-admin — changelog

## 0.17.0 — the bundled SDK carries `last_owner` (2026-09-04)

No source change. This package bundles `@realm-id/sdk`, and the previous
bundle predated `last_owner` entering the error taxonomy — so the console would
have kept rendering "you are about to strand this tenant" as a generic
`conflict`, which is the exact defect that fix exists to close, surviving inside
the bundle.

Bundled `@realm-id/sdk` is now `0.50.0`. Verified against the INSTALLED tree,
not the packed tarball.

⚠️ `0.16.0` was never published: it was packed without its bundled dependency
(a workspace-root install hoists `@realm-id/sdk` out of
`packages/admin/node_modules`, so `bundledDependencies` packs nothing and the
tarball comes out at ~41kB instead of ~196kB **with no error**). The version is
skipped rather than reused.

## 0.15.0 — the two pagination-input error codes (2026-09-03)

- Bundles `@realm-id/sdk` with `invalid_cursor` and `invalid_limit` registered
  in the error taxonomy. The issuer now answers `400` with these instead of
  absorbing bad pagination input; unregistered, they would collapse to a bare
  `bad_request` in `error.code` and a console could not branch on them.
- **A separate version from `0.14.0` on purpose.** `0.14.0` was never published
  and re-packing it under the same filename looked like the cheaper fix — but
  `ui/web` pins the tarball by filename AND npm honours the lockfile
  `integrity`, so the rebuilt tarball was silently ignored: the installed
  bundle still lacked both codes after a forced reinstall. A content change
  needs a NEW version number or the pin masks it. Verified this time by
  grepping the INSTALLED `dist`, not the packed one.

## 0.14.0 — BREAKING: `apiKeys.list` returns the pager, not an array (2026-09-03)

- **`apiKeys.list(platformId)` now returns `Paginated<ApiKeyListItem>`.** It
  read the SPEC §7 envelope and returned `page.items ?? []`, so a console
  rendered page one as if it were the whole set with no way to tell. This
  client is package-local (it deliberately overrides the bundled
  `@realm-id/sdk` one), so the upstream fix did not reach it — fixing only
  `@realm-id/sdk` would have left `ui/web` truncated.
  Use `.page({ cursor, limit })` or `for await`.
- **`sources.list`, `serviceAccounts.list` and `userApiKeys.list` change the
  same way**, via the bundled `@realm-id/sdk`.
- **New re-exports**: `Paginated`, `Page`, `PageOpts` (types) and `readPage`,
  `writePage` (values) — a consumer that cannot name `Paginated` cannot type
  the value it just received, and `writePage` is the one correct way to re-emit
  a decoded page.
- `ApiKeyListPage` gains `has_more?: boolean` — the truncation signal, not
  derivable from `items`.
- Bundles `@realm-id/sdk` with the `has_more` envelope and the decode →
  re-encode round-trip guard.

## 0.13.0 — BREAKING: a user API key is bound to ONE org (ADR-105) (2026-09-01)

- `OrgScope` is no longer re-exported — the type is deleted upstream in
  `@realm-id/sdk` 0.46.0, which this package bundles. A key mints into exactly
  one org, always the minting principal's own tenant, so the scope enum and the
  multi-org allowlist it selected have nothing left to describe.
- Bundles `@realm-id/sdk` `0.46.0`, which also carries ADR-102's minting `login`
  and the `productRoles` handler.

## 0.12.0 — BREAKING: the re-vendor that carries the `integrations.install()` fix (2026-08-31)

- Bundles `@realm-id/sdk` `0.45.0`, whose `integrations.install()` sends
  `permissions` instead of the retired `role_id`. **The ts fix alone does not
  reach you**: `web-admin` bundles its own copy of `@realm-id/sdk`, so it shipped
  the broken call too — and its wiring test passed precisely BECAUSE it resolved
  against the stale vendored copy.
- `InstallRequest.permissions: string[]` replaces `role_id`; `role_id` and
  `role_name` are gone from the install response.

## 0.11.0 — the role vocabulary (ADR-101 D1 write side) (2026-08-30)

- **`admin.roleTemplates`** — RealmID's role VOCABULARY, not one realm's roles.
  Base-realm-gated (ADR-101 D4), so in a partner console every verb answers
  `role_authoring_retired`: do not render its affordances outside the base
  realm.
- Bundles `@realm-id/sdk` `0.44.0`.

## 0.10.0 — SSO domains, federation bindings, transfer-by-email; notes move behind `/internal` (2026-08-30)

**BREAKING (one item):** `admin.notes` and the `PlatformNotesClient` export are
gone from the package root. See the last bullet.

- **`admin.ssoDomains`** (ADR-094) — the nine per-org SSO domain-grant calls:
  `list` / `claim` / `verify` / `request` / `revoke` on the org-scoped path, and
  `listForPlatform` / `approve` / `reject` on the platform owner's queue, which
  addresses a grant by **id**, not domain. Partners MUST surface this flow — an
  org cannot self-serve from an RI-hosted console — which is why it is SDK
  surface. A failed `verify` is a `200` with `verified: false`, not an error:
  "the record is not published yet" is the normal state while a customer sets
  DNS up. NOT `admin.domains`, which is ADR-049 ROUTING; a routing domain must
  never confer SSO.
- **`admin.federationBindings`** (ADR-057) — wired onto `@realm-id/sdk`'s
  existing `FederationBindingsClient`, bound to the admin's `realmId` like every
  other `/platforms/{id}/…` resource. Bindings are IMMUTABLE server-side, so a
  "rotate" composes create-then-revoke; there is no update route to add.
- **`AdminTenantsClient.transferOwner(id, recipient, opts)`** — widened to take
  either a resolved user id or `{ email }`, the **ADR-087 parent path**: a
  platform owner acting on one of their realm's orgs cannot read the target's
  roster at all (ADR-067 keeps roster reads own-tenant only), so they must name
  the recipient by address and the server resolves or PROVISIONS it. Adds
  `suspendOutgoingOwner`. Exactly ONE recipient key is ever sent, and two
  refusals happen locally rather than costing a round trip: an empty recipient,
  and `leaveEntirely` together with `suspendOutgoingOwner` (the issuer's
  `conflicting_outgoing_disposition`).
- **Role predicates re-exported** — `isRoleAssignableTo`, `isRoleSeatable`,
  `rolesAssignableTo`, `confersAuthority`, `NON_ASSIGNABLE_ROLES`,
  `HUMAN_ONLY_PERMISSIONS`. ⚠️ The first two are **not interchangeable**:
  `isRoleAssignableTo` is the exact server mirror with no name or disabled
  guards, so an `owner` row with an empty `assignable_to` passes it;
  `isRoleSeatable` adds the guards a PICKER needs. Anything offering a choice to
  a human must use `isRoleSeatable` / `rolesAssignableTo` or it will offer
  `owner`. A test asserts the split survives the re-export.
- **`unwrapData` / `parseErrorEnvelope` re-exported**, and this package's own
  copy of `unwrapData` is DELETED — the transport now parses the envelope with
  `@realm-id/sdk`'s implementation, and a test walks the source directory to
  fail if a local copy comes back. `ActiveSession` is now a re-export of
  `@realm-id/web`'s `RevocableSession` rather than a second declaration.
- **BREAKING — `PlatformNotesClient` moved to `@realm-id/web-admin/internal`.**
  It targets the issuer's `/admin/platforms/{id}/notes`, a **base-realm
  staff-only** surface: a partner platform owner, who is this package's
  audience, can only ever receive `403` from it. It is not deleted (RealmID's
  own console needs it) but it no longer advertises an API nobody outside
  RealmID can call. Migration: `import { createOpsAdmin } from
  "@realm-id/web-admin/internal"` and use that in place of `createAdmin` — it
  returns the whole partner surface plus `notes`. The subpath carries no
  stability promise.

## 0.9.1 — `MeMembership.realm_id` (issuer spec 0.34.0)

Type-only, additive.

- **`MeMembership.realm_id?: string`** — the realm the membership's TENANT
  LIVES IN. `platform_id` cannot answer that: on an admin tenant it names the
  realm being ADMINISTERED while the tenant lives in the base realm (ADR-015).
- Use it to decide whether a platform bearer you hold can act on a tenant
  (ADR-097 §E refuses a mint across realms) instead of inferring from
  `is_admin_tenant` — that inference is safe in one direction only and hides a
  working control from base-realm sub-tenant members.
- Optional because `/me` reaches a browser through a BFF that re-encodes it: a
  BFF that has not declared the field drops it. Absent means unknown.

## 0.9.0 — ADR-100 passthrough (2026-08-27)

**BREAKING**, and entirely inherited — this package owns no types of its own
here, it re-exports `@realm-id/sdk`.

- `admin.userApiKeys.create` now requires `uncapped`; `admin.userApiKeys.update`
  is available (`PUT`, one shared write schema, resets what it omits).
- `UserApiKeyWrite` re-exported.
- **`admin.scopes.remove` is GONE** — the endpoint was deleted outright
  (ADR-100 D10). `admin.scopes.rename` is untouched, and now carries the
  dry-run and realm-id-default coverage the removed tests used to hold.

## 0.8.20 — `admin.scopes.rename` + `admin.scopes.remove` (ADR-097 §F, §G)

Wires the ts SDK's `ScopesClient` onto the admin handle:
`admin.scopes.rename({ from, to, dryRun })` →
`POST /platforms/{id}/scopes/rename`, and
`admin.scopes.remove({ scope, onEmpty, dryRun })` →
`POST /platforms/{id}/scopes/remove`. Both realm-owner only.

**`remove` is not a narrowing operation in every case, and that is the point.**
An empty `permissions_cap` means NO RESTRICTION, so removing a key's last scope
leaves it UNRESTRICTED rather than powerless. The server refuses such a removal
(`409 scope_removal_would_uncap`, nothing written) unless you pass
`onEmpty: "revoke"`. Call with `dryRun: true` first and read `emptied` — it is a
list of ROWS, and the preview is the only surface that can hand it to you,
because the 409 error envelope carries no payload.

`remove` needed no code here: `ScopesClient` comes from `@realm-id/sdk`, so it
arrived with ts `0.40.0`. What it needed was a TEST — this package had none
going through `createAdmin` at all, so the wiring both entries claim was
unverified in either direction. Five now do, mutation-verified.

Renames one of the PARTNER'S scope strings across every user API key cap in the
realm, in one transaction: idempotent, deduping on collision, dry-runnable.

**Not reversible in general** — where a key held both `from` and `to`, the merge
destroys what a reversal would need. `dryRun` is not a convenience; preview
first.

`realm_roles.permissions` is NOT renamed and the `roles` count is always `0`:
that column is validated against RealmID's own ADR-074 catalog on every write,
in every realm, so it holds RealmID's vocabulary rather than a partner's.

## 0.8.19

- **`platforms.get(id)`** — `GET /platforms/{id}`, the owner-facing by-id read
  (issuer `v0.87.0`, spec `0.24.0`). The singular counterpart of
  `platforms.listMine()`, returning the same `Platform` row for one platform.
  Authorization is INHERITED from `/platforms/mine` rather than restated, so an
  M2M platform key works here — which is the point, since this is the read a
  partner's own tooling needs.

- **`admin.getPlatform(id)`** — `GET /admin/platforms/{id}`, the base-realm
  staff fleet row, carried in via the bundled `@realm-id/sdk` `0.36.0`. This is
  what lets a platform-detail screen stop paging `admin.listPlatforms()` and
  matching client-side: that pattern is capped by the caller's page budget, and
  a platform past the cap looks exactly like one with no data.

  **Both endpoints answer `404` identically for "not visible to you" and "never
  existed", and consumers must preserve that.** Never re-label either 404 as a
  permission error — a distinct refusal confirms the id is live, which is the
  enumeration oracle the identical 404 exists to close (issuer `DECISIONS.md`
  2026-08-06). Note `platform_not_found` is not in the `ErrorCode` taxonomy, so
  it surfaces as `not_found` with `httpStatus: 404`.

- **No new fields in this release.** `ActiveSession.device_name` (ADR-062) and
  `RoleObject.assignable_to` / `can_invite_roles` (ADR-081 / ADR-076 WP4) were
  already carried by `0.8.18` — verified inside the packed tarball, not just in
  `types.ts`. `sdk/TODO.md` had recorded them as still-owed and blocked on a
  repack; that was **stale**, and the consuming shims in `ui/web` (a
  `& { device_name?: string }` augmentation and five `as AssignableRoleLike`
  casts) have now been deleted rather than widened.

## 0.8.18

- **`MeMembership.invitation_pending`** (issuer `v0.83.0`, ADR-095 D5) — the
  flag that decides whether a membership row gets **Accept + Decline** or
  **Leave**. The wire has carried it since `v0.83.0` and the BFF passes it
  through `/me`; only this published type understated it, so any consumer
  trusting the type had to key the controls on `pending_first_signin` and
  re-derive the exact defect `v0.83.0` fixed.

  The two flags are ORTHOGONAL and both are true on a pending invitation, which
  is what makes the wrong one look right in testing: `invitation_pending` means
  an OFFER is awaiting an answer (`users.status='invited'`, the precondition
  both handlers enforce), while `pending_first_signin` means nobody has SIGNED
  IN yet (no approved provider tuple). Accepting writes no provider tuple —
  only a login does — so a settled invitation keeps `pending_first_signin` and
  a `pending_first_signin`-keyed UI keeps offering two actions the issuer now
  refuses with `not_invited` / `not_pending`. A bulk-imported member is the
  mirror case: unclaimed, with nothing to answer.

  Type-only and additive; no runtime change.

## 0.8.17

- **`Tenant.allowed_domains` is DROPPED (ADR-094 R3, issuer `v0.77.0`).**
  BREAKING for anyone reading the field. The column is gone server-side, so
  leaving it typed `string[]` would let `t.allowed_domains.length` typecheck
  and throw on `undefined` at runtime. Domain SSO is a `tenant_domains` grant,
  read through the domains API. Also dropped from tenant create. Bundles
  `@realm-id/sdk` 0.34.0.

## 0.8.16

- **`MeMembership.permissions` + `MeMembership.is_admin_tenant` (ADR-090,
  issuer `v0.71.0`).** Gate affordances on the permission, never on
  `role === "admin"` — a role's NAME confers nothing since issuer `v0.54.0`
  made the starter roles opt-in. There is no implicit-all marker to expand: an
  owner arrives with the whole catalog already listed and already intersected
  with the token's ADR-084 `permissions_cap`. `is_admin_tenant` exists because
  `permissions` alone over-reports — a realm-scoped gate additionally requires
  sitting in the realm's admin tenant.

## 0.8.15

- **`MeMembership.is_owner`** — the caller's ADR-076 owner-ness, resolved by
  the issuer from the `tenants.owner_user_id` pointer. Gate owner-only UI on
  this, never on `role === "owner"`: ADR-076 retired that marker and demoted
  the rows to `admin`, so no user carries it and a role-string check hides
  owner affordances from every actual owner.

## 0.8.14

- **`admin.userApiKeys`** — the ADR-084 end-user API-key resource
  (`UserApiKeysClient`, re-exported from `/internal`).

## 0.8.13

- **`label` + `expires_at` on API-key list rows** (issuer `v0.61.0`). `label`
  is the only handle on a key — the plaintext is echoed once and `prefix` is
  hash-derived — so a list without it cannot be traced back to its row.
  `revoked_at` / `expires_at` are nullable.

## 0.8.12

- **`platforms.createTenant` now carries the owner (compile-enforced).** Since
  issuer v0.59.0 (ADR-073 Amendment C) `tenants.owner_user_id` is NOT NULL and
  `POST /platforms/{id}/tenants` requires an inline `owner`; the method was
  still typed `{ display_name }`, so ui/web had to route creates through a
  `createOrgWithOwner` gap shim to avoid a silent `owner_required` 400. The
  input is now `{ display_name; owner: TenantOwner; id?; created_at? }` (owner
  required, `id`/`created_at` the optional bulk-migration passthroughs),
  reusing the bundled `@realm-id/sdk` `TenantOwner` type. The shim can retire.

## 0.8.11

- **Transport no longer mislabels client-side auth errors as `network`.**
  `realm.fetch` throws a typed `RealmError` for conditions it detects before a
  request leaves the browser — chiefly `unauthorized` / "no current tenant"
  when the session's current tenant is cleared out from under an in-flight call
  (the long-idle reload teardown race). The transport wrapped *every* throw as
  `code:"network"`, hiding the real code behind a misleading
  `network error calling GET /me: no current tenant`. It now re-throws
  `RealmError` instances unchanged and only wraps genuine fetch failures
  (`TypeError`) as `network`, so callers can branch on the real code and route
  a dead session to sign-in instead of a fatal "network error" retry screen.

## 0.8.10

- **Cross-realm integrations surface (ADR-082/083)** — `admin.integrations`:
  source realms register integrations, target realms install them, source
  realms mint short-lived access-only tokens. Additive.
- **ADR-081 role typing** — roles declare `assignable_to` (`users.kind` that may
  hold the role) alongside `required_mfa_methods` / `can_invite_roles`.

## 0.8.9

- `PlatformCreate.starter_roles` + new `StarterRole` union (`"admin" | "viewer"`)
  — opt into RealmID's role templates at platform creation (issuer v0.54.0).
- `platforms.seedStarterRoles(platformId, roles)` — the post-creation
  counterpart, `POST /platforms/{id}/starter-roles`. Requires `roles:manage`.

Additive and optional: omitting `starter_roles` reproduces the previous request
exactly.

## 0.8.8

- **Issuer `v0.52.0` read surfaces typed** — platform config plus the platform
  and fleet stats aggregates. Config is a LOOSE map by design: the key set is
  derived server-side by reflection from `RealmConfigPatch`, so a hand-typed
  shape would go stale and silently drop new keys.

## 0.8.7

ADR-080 Phase B + session-revoke + self-MFA typed parity (issuer v0.50.0).
Additive; all new surfaces already worked via the BFF `/api` passthrough.

- **`admin.tenants.users.delinkContact(tenantId, userId, contactId)`** →
  `DelinkContactResult` (`POST …/users/{uid}/contacts/{contactId}/delink`) —
  the owner action that unblocks a `contact_admin_required` login (ADR-080 Part 2).
- **`admin.tenants.users.handBack(tenantId, userId, fromUserId)`** →
  `HandBackResult` (`POST …/users/{uid}/hand-back`) — reactivate a parked
  account and move a mistakenly-created account's email onto it (ADR-080 Part 3).
- **`admin.tenants.driftReviews.rejectHard(tenantId, reviewId)`** →
  `DriftRejectResult` (`POST …/contact-drift-reviews/{id}/reject` with
  `{hard:true}`) — park an account on a suspected takeover. `reject()` (soft)
  is unchanged; the result type now carries `mode`/`parked`/`revoked_bindings`
  (the old `new_user_id`/`original_value` are gone).
  `admin.tenants` is now an `AdminTenantsClient` (extends the bundled
  `TenantsClient`; every existing method is inherited).
- **`admin.sessions.revokeUser(tenantId, userId)`** and
  **`admin.sessions.revokeRealmSessions(realmId)`** → `SessionRevokeResult`
  (`POST …/users/{uid}/sessions/revoke`, `POST /platforms/{id}/sessions/revoke-all`).
  Self-service `revoke`/`revokeAll` are unchanged.
- **`admin.mfa`** (`MfaClient`) — self-service MFA:
  `listAuthenticators()` → `AuthenticatorList` (`GET /auth/mfa/authenticators`)
  and `regenerateRecoveryCodes()` → `RecoveryCodes`
  (`POST /auth/mfa/recovery/regenerate`; 409 `not_enrolled` / 412 `mfa_required`).
- **`isContactAdminRequired(err)`** + `CONTACT_ADMIN_REQUIRED` constant — branch
  on the ADR-080 login gate regardless of whether it surfaces via `.code` or the
  preserved `.details.server_code` (the canonical `ErrorCode` union lives in the
  bundled `@realm-id/sdk`, which this package does not modify).

New exported types: `SessionRevokeResult`, `Authenticator`, `AuthenticatorList`,
`RecoveryCodes`; re-exported `DelinkContactResult`, `HandBackResult`.

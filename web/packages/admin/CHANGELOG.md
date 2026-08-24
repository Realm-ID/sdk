# @realm-id/web-admin — changelog

## 0.8.20 — `admin.scopes.rename` (ADR-097 §F)

Wires the ts SDK's `ScopesClient` onto the admin handle:
`admin.scopes.rename({ from, to, dryRun })` →
`POST /platforms/{id}/scopes/rename`, realm-owner only.

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

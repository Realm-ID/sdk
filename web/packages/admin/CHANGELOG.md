# @realm-id/web-admin — changelog

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

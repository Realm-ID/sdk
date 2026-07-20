# @realm-id/web-admin — changelog

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

# Error reference

Every SDK failure raises a single error type — `RealmError` (TS),
`*RealmError` (Go), `RealmException` (Java) — carrying:

- `code` — stable, machine-readable identifier (table below).
- `message` — human-readable diagnostic.
- `httpStatus` — set when the failure originated from an API response.
- `details` — server-supplied envelope siblings
  (`mfa_challenge_token`, `revocation_token`, `active_sessions`,
  `tenant_id`, …).
- `cause` — wrapped underlying error.

The wire form of the code is identical across languages:
`MFA_REQUIRED.wire() === "mfa_required"` in Java equals
`err.code === "mfa_required"` in TS equals
`err.Code == realmid.ErrCodeMFARequired` in Go.

## Verifier codes

These fire from `realm.verify(token)`.

| Code                  | When                                                                | What to do                                                                               |
|-----------------------|---------------------------------------------------------------------|------------------------------------------------------------------------------------------|
| `malformed`           | Token isn't 3 dot-separated parts, or header/payload aren't JSON.   | Reject the request with 401. Don't retry.                                                |
| `wrong_algorithm`     | Header `alg` is not `RS256`.                                        | Reject. A non-RS256 token did not come from RealmID.                                     |
| `bad_signature`       | Signature did not verify against the realm's JWKS.                  | Reject. May indicate token forgery or a network-corrupted token.                         |
| `wrong_issuer`        | `iss` claim does not start with `${baseUrl}/${realmId}`.            | Reject. Either misconfigured `baseUrl` or token from a different realm.                  |
| `wrong_audience`      | `aud` claim does not equal the realm's audience (auto or override). | Reject. Tokens minted for a different audience cannot replay against your service.       |
| `expired`             | `exp` is in the past beyond leeway.                                 | Return 401. Client should refresh and retry.                                             |
| `not_yet_valid`       | `nbf` is in the future beyond leeway.                               | Reject. Likely clock skew if seen often.                                                 |
| `unknown_kid`         | Token's `kid` header is not in the (refetched) JWKS.                | Reject. Indicates key rotation that hasn't completed, or a forged token.                 |
| `jwks_fetch_failed`   | JWKS HTTP fetch returned non-200 or transport failed.               | Treat as transient. The SDK does not retry; caller may.                                  |

## Auth-flow codes

These fire from `realm.auth.*` calls.

| Code                      | When                                                                                         | What to do                                                                                                |
|---------------------------|----------------------------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------------|
| `provider_token_invalid`  | Upstream IdP rejected the token (Firebase / Google).                                         | Surface to user. Often means the IdP session expired client-side.                                         |
| `mfa_required`            | Login or refresh succeeded as far as identity, but MFA step-up is required.                  | Read `details.mfa_challenge_token` and `details.methods`; prompt user for code; call `auth.mfaVerify`.    |
| `session_limit_reached`   | The user has too many active sessions for the realm's policy.                                | Read `details.revocation_token` + `details.active_sessions`; let user pick one to revoke; retry login.    |
| `tenant_required`         | `auth.token` was called without a `tenantId` and the user belongs to multiple.               | Surface a tenant picker; supply `tenantId` to `auth.token`.                                                |
| `tenant_invalid`          | `tenantId` is not a tenant the user belongs to in this realm.                                | Reject; the picker shouldn't have offered it.                                                              |
| `token_stale`             | (401, verifier-emitted, ADR-107) The token was minted before its subject's authority changed.  | Refresh ONCE and replay; never treat it as a sign-out (check it before any generic 401 handling).        |
| `user_suspended`          | (403; the issuer also sends 401 on the user-API-key exchange) The user's row in THIS org is suspended or deactivated (ADR-104 R-d). | Show "not allowed in this org". Do not sign the user out of other orgs; the Go BFF middleware relays it without tearing the session down. Breaking in go 0.66.0: it used to be `forbidden` + `details.server_code`. |
| `escort_suspended`        | (403 from the issuer, shown as 503 by the Go BFF middleware) Your backend's `/auth/*` escort account is suspended or deactivated (ADR-104 R-d). | A service problem, not the user's: alert operators. The session is untouched. |
| `account_suspended`       | The user's account is suspended.                                                             | Surface a "your account is suspended" message; do not retry.                                              |
| `account_deactivated`     | The user's account is deactivated.                                                           | Surface a "this account has been closed" message.                                                         |
| `realm_origin_mismatch`   | The request's `Origin` header disagrees with the body's `realm_id`.                          | Configuration error — either set `createRealm({ origin })` correctly or stop overriding per call.         |
| `bff_bearer_required`     | A `/auth/*` call reached the issuer without a platform token (ADR-088 — the BFF requirement is unconditional). | Call through the SDK's `realm.auth.*` (it attaches the platform token); never let a browser hit the issuer directly. |
| `missing_origin`          | Server requires an Origin (or body `realm_id`) and got neither.                              | The SDK auto-attaches Origin from `realm.info()`, so this should not fire under normal use.               |

## Sign-in, token and escort codes (issuer wire codes)

These are the codes the issuer itself puts on `/auth/*` responses (and on the escort headers a
backend sends with them). The SDK maps most of them onto the codes above; a few arrive verbatim
as `code`. HTTP status is in brackets.

| Code | When | What to do |
| --- | --- | --- |
| `bad_json` | [400] The request body is not valid JSON. | Fix the request; do not retry unchanged. |
| `internal` | [500] The issuer failed on its side; the body is deliberately generic. | Treat as transient. If it repeats, send support the time and request id. |
| `missing_grant_type` | [400] `POST /auth/login` had no `grant_type`. | Send `grant_type` (the old `method` field is gone). |
| `bad_grant_type` | [400] `grant_type` is not one the issuer supports. | Use one of the documented grants. |
| `missing_provider` | [400] `grant_type=provider_token` without `provider`. | Send the provider name alongside the token. |
| `unknown_method` | [400] The login method is not enabled for this realm (a provider with no configured verifier, or password sign-in switched off). | Do not offer that method; read the realm's discovery document to see what is on. |
| `bad_tenant_id` | [400] A provider login named a `tenant_id` that is not in this realm. | Drop it (realm-root sign-in needs none) or send a tenant of this realm. |
| `missing_api_key` | [400] An api-key grant had no `api_key`. | Send the key. |
| `missing_tenant_id` | [400] `POST /auth/token` refreshed a **user** session without `tenant_id`. Service and platform sessions need none. | Send the `tenant_id` of the org the session is for. |
| `missing_fields` | [400] MFA verify without `mfa_challenge_token` or `code`. | Send both. |
| `scope_not_supported` | [400] A `scope` was requested on a session class that mints no `scope` claim. | Omit `scope`. |
| `reserved_claim_key` | [400] A `custom_claims` key is a reserved JWT claim name. | Rename the key. |
| `password_too_short` / `password_too_long` | [400] A new password is under 12 or over 1024 bytes. | Ask for a new password within bounds. |
| `password_unchanged` | [400] The new password equals the current one. | Ask for a different password. |
| `password_change_not_required` | [400] A change was sent at sign-in but the password has no pending change. | Omit `new_password`; change it later through the password-change call. |
| `invalid_credentials` | [401] The password, api key, one-time code or provider token was wrong. Unknown identifier and wrong secret look identical on purpose. | Re-prompt. Do not tell the caller which part was wrong. |
| `invalid_audience` | [401] The provider token's `client_id` (or Firebase project) is not registered for this realm or tenant. | Register the client id in the realm's identity-provider settings. If it is registered for one organisation only, send that organisation's `tenant_id` on login. |
| `revoked_api_key` | [401] The api key was revoked. | Provision a new key. |
| `keyless_api_key` | [401] The api key is not bound to a bot user. | Re-provision the key. |
| `refresh_invalid` | [401] The refresh token is expired, revoked, or was replayed. Terminal. | Send the user through sign-in again; retrying cannot help. |
| `m2m_refresh_withdrawn` | [401] The session came from an api key or workload assertion and has no refresh token. | Mint again from the key or assertion; do not refresh. |
| `bff_bearer_invalid` | [401] The platform bearer on an `/auth/*` call has a bad signature or audience, or its session is revoked. | Fetch a fresh platform token. |
| `bff_bearer_expired` | [401] The platform bearer has expired. | Fetch a fresh platform token and retry. |
| `bff_bearer_realm_mismatch` | [401] The platform bearer was issued for a different realm. | Use the bearer for the realm you are calling. |
| `bff_bearer_invalid_tenant` | [401] The bearer's tenant is not this realm's admin tenant. | Use a platform token, not an org user's token. |
| `bff_bearer_invalid_role` | [401] The bearer is not a platform-API or owner token for this realm. | Use the platform key's token. |
| `x_user_token_required` | [401] A platform-bearer call needed the user's `X-User-Token` and had none (a bare `X-On-Behalf-Of-User` is refused). | Forward the end user's token in `X-User-Token`. |
| `x_user_token_invalid` | [401] `X-User-Token` has no subject. | Forward a token the issuer minted. |
| `x_user_token_realm_mismatch` | [401] `X-User-Token` belongs to a different realm than the bearer. | Pair tokens from the same realm. |
| `insufficient_scope` | [401] A revocation token was presented where it may not bulk-revoke sessions. | Use the user's access token. |
| `not_a_member` | [403] The user is not a member of the requested tenant. | Offer only tenants the user belongs to. |
| `no_permissions_in_org` | [403] A key's permission cap and the holder's role in the key's org have nothing in common. | Re-issue the key with a cap the holder's role covers. |
| `user_not_invited` | [403] Sign-in by someone with no membership anywhere, in a realm that does not allow open sign-up. | Ask an org owner for an invitation. |
| `signup_domain_not_allowed` | [403] The email domain is not allowed to sign up. | Use an address on an allowed domain. |
| `password_must_change` | [403] The password was correct but an administrator set it and it must be changed first. | Collect a new password and resend it as `new_password`. |
| `realm_not_found` | [404] The realm the bearer is for does not exist. | Check the realm id. |
| `contact_admin_required` | [409] The identifier is managed by the user's organization and is bound to a different provider. | Tell the user to contact their organization's admin. |
| `no_verified_email` | [409] A reset link was requested for a member with no verified email. | Have the member verify an address first. |
| `reset_token_invalid` | [400] The password-reset link is not valid. | Ask for a new link. |
| `reset_token_expired` | [410] The reset link has expired. | Ask for a new link. |
| `reset_token_used` | [410] The reset link was already used. | Ask for a new link if the password still needs resetting. |
| `reset_token_superseded` | [410] A newer link was sent, or the password changed since. | Use the newest link. |
| `realm_suspended` | [410] The realm is suspended or deactivated. | Surface a service-unavailable message; do not retry. |
| `mfa_registration_required` | [412] Sign-in is blocked until the user enrols an authenticator; the envelope carries a challenge token. | Run the first-login enrolment flow with `details.mfa_challenge_token`. |
| `first_login_pending_approval` | [412] First sign-in on a recently vacated contact awaits the tenant owner's approval. | Tell the user to wait for the owner; nothing to retry. |
| `mfa_too_many_fails` | [429] Too many wrong MFA codes for this challenge. | Back off; the user may need to restart sign-in. |
| `login_throttled` | [429] Too many attempts for this identifier; counted on the identifier as sent, so unknown and known ones throttle alike. | Wait before retrying. |
| `reset_throttled` | [429] Too many reset links were sent for this member in the last hour. | Wait before sending another. |

## Cross-realm integration codes (`realm.integrations.*`, ADR-082/083)

> **Contract change (ADR-101 D7, issuer `v0.113.0`).** Installing an
> integration now *states* a permissions list; the role-based install
> (`role_id` + a `["service"]`-typed role) is retired. The issuer no
> longer emits `role_not_service_typed`, `role_not_installable` or
> `role_unavailable` — they stay in the SDK code unions only for older
> servers — and the published SDK `install()` bodies still send
> `role_id`, which a current issuer refuses with `permissions_required`
> (send `{ integration_id, permissions }` directly until the SDKs
> re-release).

| Code | Meaning | What to do |
| --- | --- | --- |
| `slug_taken` | `register` — slug already used in the realm. | Pick a different slug. |
| `permissions_required` | `install` — the stated grant is empty (or the retired `role_id` body was sent). | Name at least one ADR-074 catalog permission the integration may exercise. |
| `permissions_exceed_grantor` | `install` — the list names permissions the installing owner could not grant. | Narrow the list to what the owner actually holds. |
| `install_grants_nothing` | **`mint`, not `install`** — the installation row states no permissions and can authorise nothing. | Re-install stating permissions. A typo'd grant is refused at install time (`unknown_permission`), so this means an install that predates the check or was emptied. |
| `integration_disabled` | `install` / `mintToken` — the source platform disabled the integration. | Ask the source to re-enable it. |
| `already_installed` | `install` — a live installation already exists for this org. | Uninstall the existing one first, or reuse it. |
| `installation_revoked` | `mintToken` — the target org uninstalled. | Stop minting; the edge is gone. |
| `key_class_mismatch` | `mintToken` — the api key is not a platform-class key. | Mint with the realm's `platform_api` key, not a service key or user token. |
| `installation_not_found` | `mintToken` — unknown installation id, **or** a platform key from a realm other than the integration's (no cross-realm existence oracle). | Verify the installation id and that you are minting with the source realm's key. |

## Management / generic codes

These fire from any HTTP-backed call.

| Code            | When                                                                  | What to do                                                                                              |
|-----------------|-----------------------------------------------------------------------|---------------------------------------------------------------------------------------------------------|
| `unauthorized`  | Server returned 401. API key revoked, platform token tampered, etc.   | Re-check credentials. The SDK will not retry.                                                            |
| `forbidden`     | Server returned 403. Role does not permit the operation.              | Surface a permission error. Check that the API key's role covers the call.                              |
| `not_found`     | Server returned 404.                                                  | Treat as resource-not-present. Useful for `realm.tenants.get(unknownId)`.                                |
| `conflict`      | Server returned 409. Optimistic-concurrency or unique-constraint violation. | Re-fetch and retry, or surface to user (e.g. duplicate tenant name).                                |
| `rate_limited`  | Server returned 429.                                                  | Read `Retry-After` (the SDK puts it in `details`). Back off and retry.                                  |
| `bad_request`   | Server returned 400 / 412 with a non-mfa code, or the SDK rejected your input shape. | Inspect `details` for field-level info; fix the request.                                       |
| `network`       | Transport failure — DNS, TCP, TLS handshake, timeout.                 | Treat as transient. The SDK does not retry; caller policy varies.                                       |
| `server_error`  | Server returned 5xx, or returned an unexpected wire shape.            | Treat as transient. If repeating, capture the request id (in `details.request_id` if present) for support. |

## Working with envelope siblings

The 412 envelopes the server emits carry siblings alongside the
`error.code`:

```json
{
  "error": {
    "code": "mfa_required",
    "message": "MFA required for this resource"
  },
  "mfa_challenge_token": "ch_...",
  "methods": ["totp"]
}
```

The SDK lifts those siblings into `error.details`:

```ts
try {
  await realm.auth.login({ method: "firebase", providerToken: t });
} catch (e) {
  if (e instanceof RealmError && e.code === "mfa_required") {
    const ch = e.details?.mfa_challenge_token;
    const methods = e.details?.methods;
    // Prompt user; call realm.auth.mfaVerify({ challengeToken: ch, code, method })
  }
}
```

```go
var rerr *realmid.RealmError
if errors.As(err, &rerr) && rerr.Code == realmid.ErrCodeMFARequired {
    ch := rerr.Details["mfa_challenge_token"].(string)
    // ...
}
```

```java
try {
    realm.auth().login(req);
} catch (RealmException e) {
    if (e.getCode() == ErrorCode.MFA_REQUIRED) {
        String ch = (String) e.getDetails().get("mfa_challenge_token");
        // ...
    }
}
```

You never have to re-fetch context: every sibling the server emits is
already on the error object.

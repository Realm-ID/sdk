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
| `account_suspended`       | The user's account is suspended.                                                             | Surface a "your account is suspended" message; do not retry.                                              |
| `account_deactivated`     | The user's account is deactivated.                                                           | Surface a "this account has been closed" message.                                                         |
| `realm_origin_mismatch`   | The request's `Origin` header disagrees with the body's `realm_id`.                          | Configuration error — either set `createRealm({ origin })` correctly or stop overriding per call.         |
| `bff_bearer_required`     | A `/auth/*` call reached the issuer without a platform token (ADR-088 — the BFF requirement is unconditional). | Call through the SDK's `realm.auth.*` (it attaches the platform token); never let a browser hit the issuer directly. |
| `missing_origin`          | Server requires an Origin (or body `realm_id`) and got neither.                              | The SDK auto-attaches Origin from `realm.info()`, so this should not fire under normal use.               |

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

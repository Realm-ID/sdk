# @realm-id/sdk — Go

Go SDK for verifying RealmID-issued JWTs. Sibling TypeScript SDK lives at
[`../ts/`](../ts).

## Install

```bash
go get github.com/Realm-ID/sdk/go
```

## Usage

```go
package main

import (
    "context"
    "errors"
    "log"

    realmid "github.com/Realm-ID/sdk/go"
)

func main() {
    // There is no standalone NewVerifier in the Go SDK — construct the
    // handle and call Verify. A verifier-only handle needs no API key;
    // pass the audience per-call via VerifyOptions so Verify never
    // falls back to the credentialed Info() auto-discovery.
    realm, err := realmid.NewRealm(realmid.Config{
        BaseURL: "https://auth.realmid.dev",
        RealmID: "your-realm-id",
    })
    if err != nil {
        log.Fatal(err)
    }

    claims, err := realm.Verify(context.Background(), accessToken, &realmid.VerifyOptions{
        Audience: "your-partner-audience",
    })
    if err != nil {
        var verr *realmid.RealmError
        if errors.As(err, &verr) {
            // verr.Code in {malformed, wrong_algorithm, bad_signature,
            //   wrong_issuer, wrong_audience, expired, not_yet_valid,
            //   unknown_kid, jwks_fetch_failed}
        }
        return
    }

    // claims.Subject, claims.TenantID, claims.Role, claims.Extra["..."]
}
```

## Upgrading to 0.63.0 — breaking changes

- **`Config.SessionStore` is REQUIRED.** `NewRealm` returns
  `(nil, err)` with `errors.Is(err, realmid.ErrSessionStoreRequired)` without
  one. Single replica: `realmid.NewMemorySessionStore()`. More than one
  replica: a shared `SessionStateStore` (see "Session store" below).
- **Every `TokensClient` method takes `ctx` FIRST:** `GateRequest(ctx, token)`,
  `IsRevoked(ctx, token)`, `MarkRevoked(ctx, token)`, `RevokeSession(ctx, key)`,
  `RecordRefresh(ctx, token)`, `Evict(ctx, key)`. The store call is bounded by
  your deadline instead of `context.Background()`. The middleware passes the
  request's ctx. `SessionStateStore.AcquireRefreshLock` now returns
  `release func(ctx context.Context) error` (was `func()`); a custom store
  must change its signature.
- **`TokensClient.Len()` is removed.** `MemorySessionStore.Len()` counts the
  in-memory store's live entries.
- **`Evict(jti)` is now `Evict(ctx, sessionKey)`.** New meaning: it takes the
  SESSION key (`sid`, falling back to `jti`) and drops that session's revoked
  entry and marks. `SessionStateStore.Evict(prefix)` is a PREFIX match (the key,
  or the key followed by `|`), so a Redis implementation must `SCAN` or keep
  an index.
- **Revocation is keyed on the session, not the token.** `MarkRevoked`,
  `RevokeOnLogout` and `Config.Revocation` now cover every access token of the
  session. `GateRequest`/`IsRevoked` also refuse a token that a later
  refresh superseded (its `iat` is below the not-before mark).
- **The middleware gates every request by default** (SPEC §10.1 step 6a): a
  revoked or superseded bearer is `401` with `revoked: true`, before the MFA
  check and before the handler. Refreshes are serialized per refresh token
  (a concurrent loser gets the winner's outcome, or `503` + `retry: true`).
  Login, refresh and MFA-verify bodies carry `org_session_mode`.
- **`Verify` is stricter.** It refuses (`malformed`) a token with an absent or
  other header `typ` (only `JWT`, `at+jwt`, `application/at+jwt`), any
  `events` claim, and a blank `sub`. Partner TEST FIXTURES that sign tokens
  without these will now fail — add `typ: "JWT"` and a `sub`.
- **Logout** revokes the session(s) the issuer names (`sid`, and every id in
  `revoked_sids` for `LogoutRequest{All: true}`). Without them it falls back to
  a bearer that VERIFIES and is unexpired: an expired or invalid bearer revokes
  nothing locally. Every refresh-cookie candidate is logged out, and the
  revocation is also pushed into `Config.Revocation`.
- **Path patterns:** `/x/**` now also matches the bare `/x` in `ExemptPaths`,
  `MFAProtectedPaths` and `ScopeRule` paths, so an `ExemptPaths` entry `/x/**`
  exempts `/x` too. `{name}` matches one non-empty segment (`ExemptPaths`
  keeps braces literal).
- **Refresh reads `custom_claims` or `customClaims`** from the request body.
- **Error envelope:** a `RealmError.Details` key named `error` no longer
  overwrites the `{error: {code, message}}` envelope. `GateRequest`'s error
  carries `HTTPStatus` 401.
- Upgrade `@realm-id/web` first, then this SDK (SPEC front matter, "Upgrade order").

## Runtime

Stdlib only — no third-party dependencies. Go 1.22+.

## HTTP middleware

The full `Realm` handle (`realmid.NewRealm(...)`) ships an `http.Handler`
middleware that handles `/login`, `/logout`, `/token` (refresh), and
`/mfa/verify` end-to-end and verifies bearer tokens on every other
route. Mount it once on your mux:

```go
realm, err := realmid.NewRealm(realmid.Config{
    RealmID: os.Getenv("REALM_ID"),
    APIKey:  os.Getenv("REALM_API_KEY"),
    SessionStore: realmid.NewMemorySessionStore(), // required; see below
})
if err != nil { log.Fatal(err) }

mw := realm.Middleware(realmid.MiddlewareOptions{
    ExemptPaths:       []string{"/health", "/public/*"},
    MFAProtectedPaths: []realmid.MFARule{{Path: "/admin/*"}},
    TokenDelivery:     "cookie", // or "body" for native / mobile clients
    // CookieName/Domain/Secure/SameSite all configurable; defaults are
    // realmid_refresh, HttpOnly, Secure=true, SameSite=Lax.
})

mux := http.NewServeMux()
mux.Handle("/me", mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
    claims, _ := realmid.ClaimsFrom(r.Context())
    json.NewEncoder(w).Encode(claims)
})))
http.ListenAndServe(":3000", mux)
```

In `"cookie"` mode (default) the refresh token is set as
`HttpOnly; Secure; SameSite=Lax` so browser JS can never read it and
XSS cannot exfiltrate it. Use `"body"` only when a cookie isn't
viable — native apps, CLIs, or truly cross-origin SPAs. See
[SPEC §10.2](../SPEC.md#102-configuration) for the full decision table.

### Session store (required since v0.63.0)

`Config.SessionStore` is **required**: `NewRealm` returns an error wrapping
`realmid.ErrSessionStoreRequired` without it. It holds every piece of
cross-request session state: revoked sessions, the refresh not-before marks,
and the refresh lock that stops two tabs from spending one refresh token twice.

- **One replica:** `SessionStore: realmid.NewMemorySessionStore()`.
- **More than one replica:** supply a shared implementation of
  `realmid.SessionStateStore` (Redis, a database). With the in-memory store a
  logout on pod A is not seen by pod B, and the refresh lock serializes nothing
  across pods. Run your implementation through the conformance suite in
  `github.com/Realm-ID/sdk/go/sessionstoretest`:

```go
func TestMyStore(t *testing.T) {
    sessionstoretest.Run(t, func() realmid.SessionStateStore { return newMyStore(t) })
}
```

Logout revokes the session the issuer names (`sid`, and every id in
`revoked_sids` for "log out everywhere"), and every access token of that
session is then refused with `401` + `revoked: true`.

### Scope denials

`ScopeMiddlewareOptions.WriteDenied` lets you shape the 403 body; unset, the
response is byte-identical to earlier releases. `{name}` in a `ScopeRule` path
or an `MFAProtectedPaths` entry matches exactly one non-empty segment
(`/orders/{id}`); `ExemptPaths` keeps braces literal.

## What's in scope

Verifier-only callers construct the handle without an API key and call
`realm.Verify(ctx, token, &realmid.VerifyOptions{Audience: ...})` — no
network calls beyond JWKS. The same handle (`realmid.NewRealm(...)`,
given an `APIKey` or an ambient workload credential) layers the auth
surface, management API, and the middleware above.

## Tests

```bash
go test ./...
```

## License

MIT — see the [LICENSE](../LICENSE) at the repo root.

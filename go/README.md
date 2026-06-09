# @realmid/sdk — Go

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

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
    "log"

    realmid "github.com/Realm-ID/sdk/go"
)

func main() {
    v, err := realmid.NewVerifier(realmid.Config{
        BaseURL:  "https://auth.realmid.dev",
        Audience: "your-partner-audience",
    })
    if err != nil {
        log.Fatal(err)
    }

    claims, err := v.Verify(accessToken)
    if err != nil {
        var verr *realmid.Error
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

## What's in scope

Just `Verify()`. Other partner-facing operations (login, logout, refresh
rotation) are HTTP — call them with `net/http` directly. See the
[partner integration guide](https://realmid.dev/docs).

## Tests

```bash
go test ./...
```

## License

MIT — see the [LICENSE](../LICENSE) at the repo root.

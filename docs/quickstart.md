# Quickstart

Pick a language. Each example is a complete, runnable program: log a
user in, verify their access token, and protect a route.

## What you need

1. A **realm id** — find it in the RealmID console.
2. An **API key** for that realm — created from the console under
   *Realm › API keys*. Format `rk_live_...`. Treat as a secret.
3. A user **provider token** — for the Firebase or Google login
   methods, this is the upstream IdP's id-token.

## TypeScript / Node

```bash
npm install @realmid/sdk express cookie-parser
```

```ts
// server.ts
import express from "express";
import cookieParser from "cookie-parser";
import { createRealm } from "@realmid/sdk";

const realm = createRealm({
  realmId: process.env.REALM_ID!,
  apiKey:  process.env.REALMID_API_KEY!,
});

const app = express();
app.use(express.json());
app.use(cookieParser());

// One line. Mounts /login, /logout, /token, /mfa/verify and verifies
// the bearer access token on every other route.
app.use(realm.middleware({
  exemptPaths: ["/health", "/public/*"],
  mfaProtectedPaths: ["/admin/*"],
}));

app.get("/health", (_, res) => res.json({ ok: true }));

app.get("/me", (req, res) => {
  // Verified claims attached by the middleware.
  res.json({ user: (req as any).realmid });
});

app.listen(3000);
```

A user-facing JS app POSTs to `/login` with
`{ method: "firebase", providerToken: idToken }`; the middleware
exchanges it for a session, sets the refresh cookie, and returns the
access token.

## Go

```bash
go get github.com/Realm-ID/sdk/go
```

```go
// main.go
package main

import (
    "log"
    "log/slog"
    "net/http"
    "os"

    realmid "github.com/Realm-ID/sdk/go"
)

func main() {
    realm, err := realmid.NewRealm(realmid.Config{
        RealmID: os.Getenv("REALM_ID"),
        APIKey:  os.Getenv("REALMID_API_KEY"),
        Logger:  slog.Default(),
    })
    if err != nil {
        log.Fatal(err)
    }

    mux := http.NewServeMux()
    mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
        w.Write([]byte(`{"ok":true}`))
    })
    mux.HandleFunc("/me", func(w http.ResponseWriter, r *http.Request) {
        claims, _ := realmid.ClaimsFrom(r.Context())
        // ... use claims
    })

    handler := realm.Middleware(realmid.MiddlewareOptions{
        ExemptPaths:       []string{"/health", "/public/*"},
        MFAProtectedPaths: []string{"/admin/*"},
    })(mux)

    log.Fatal(http.ListenAndServe(":3000", handler))
}
```

## Java

```kotlin
// build.gradle.kts
dependencies {
    implementation("dev.realmid:sdk:0.1.0")
    implementation("org.eclipse.jetty:jetty-server:11.0.20")
    implementation("org.eclipse.jetty:jetty-servlet:11.0.20")
}
```

```java
// App.java
import dev.realmid.sdk.Realm;
import dev.realmid.sdk.middleware.RealmFilter;
import org.eclipse.jetty.server.Server;
import org.eclipse.jetty.servlet.ServletContextHandler;
import org.eclipse.jetty.servlet.FilterHolder;

import java.util.List;

public class App {
    public static void main(String[] args) throws Exception {
        Realm realm = Realm.builder()
            .realmId(System.getenv("REALM_ID"))
            .apiKey(System.getenv("REALMID_API_KEY"))
            .build();

        RealmFilter filter = realm.middleware()
            .exemptPaths(List.of("/health", "/public/*"))
            .mfaProtectedPaths(List.of("/admin/*"))
            .build();

        ServletContextHandler ctx = new ServletContextHandler();
        ctx.setContextPath("/");
        ctx.addFilter(new FilterHolder(filter), "/*", null);
        // ... register your servlets

        Server server = new Server(3000);
        server.setHandler(ctx);
        server.start();
        server.join();
    }
}
```

## Verify-only mode

If you only need JWT verification (e.g. a downstream microservice
that trusts tokens minted by your edge), skip the full handle and use
the low-level verifier:

```ts
import { createVerifier } from "@realmid/sdk";

const verifier = createVerifier({
  baseUrl: "https://auth.realmid.dev",
  realmId: "01HXYZREALM",
  audience: "your-realm.com",
});

const claims = await verifier.verify(token);
```

(The Go and Java SDKs expose the same low-level primitive as
`realmid.NewVerifier(...)` and `Verifier.create(Config.builder()...)`
respectively.)

## Next steps

- [`dual-token.md`](./dual-token.md) — why login requires `apiKey`
- [`error-reference.md`](./error-reference.md) — every error code, when it fires, what to do
- [`middleware.md`](./middleware.md) — middleware behavior across all three languages
- [`../SPEC.md`](../SPEC.md) — the cross-language contract

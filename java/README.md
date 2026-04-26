# @realmid/sdk — Java

Java SDK for the [Realm ID](https://realmid.dev) authentication service.
Sibling TypeScript SDK at [`../ts/`](../ts), Go SDK at [`../go/`](../go).
The shared cross-language contract lives in [`../SPEC.md`](../SPEC.md).

## Install

```xml
<!-- Maven -->
<dependency>
  <groupId>dev.realmid</groupId>
  <artifactId>sdk</artifactId>
  <version>0.1.0</version>
</dependency>
```

```kotlin
// Gradle (Kotlin DSL)
implementation("dev.realmid:sdk:0.1.0")
```

## Usage

```java
import dev.realmid.sdk.*;
import dev.realmid.sdk.auth.*;

Realm realm = Realm.builder()
    .realmId("01HXYZ...")
    .apiKey("rk_live_...")
    // .baseUrl("https://auth.realmid.dev")  // override for staging
    // .origin("https://app.acme.com")        // optional; auto-discovered
    // .logger(System.getLogger("realmid"))
    .build();

// Verify an access token
Claims claims = realm.verify(accessToken);

// Auth flow
Session session = realm.auth().login(LoginRequest.of("firebase", providerToken));
TokenResponse refreshed = realm.auth().token(
    TokenRequest.withClaims(refreshToken, "tenant-id",
        java.util.Map.of("outlet_ids", java.util.List.of("o1"))));

// Management
realm.tenants().list().stream().forEach(t -> System.out.println(t.id()));
realm.tenants().users().list("tenant-id").stream().forEach(u -> System.out.println(u.email()));
```

## Servlet middleware

```java
import dev.realmid.sdk.middleware.RealmFilter;
import dev.realmid.sdk.middleware.TokenDelivery;

RealmFilter filter = realm.middleware()
    .exemptPaths(java.util.List.of("/health", "/public/*"))
    .mfaProtectedPaths(java.util.List.of("/admin/*"))
    .tokenDelivery(TokenDelivery.COOKIE)
    .cookieName("realmid_refresh")
    .buildFilter();
```

The filter handles login/logout/refresh/mfa-verify routes in-process and
falls through to bearer verification on every other route, attaching the
verified `Claims` to the request as attribute `realmid.claims`.

`jakarta.servlet:jakarta.servlet-api` is `compileOnly` — apps that don't
use the filter never pick up a servlet jar.

## Errors

Every failure is a `RealmException`. Branch on `getCode()`:

```java
try {
    realm.auth().login(LoginRequest.of("firebase", token));
} catch (RealmException e) {
    if (e.getCode() == ErrorCode.MFA_REQUIRED) {
        String challenge = (String) e.getDetails().get("mfa_challenge_token");
        // prompt user, then call realm.auth().mfaVerify(...)
    }
}
```

Full error taxonomy: see [`SPEC.md` §3.1](../SPEC.md#3-errors).

## Runtime

- Java 17+
- Single runtime dependency: `com.fasterxml.jackson.core:jackson-databind`
- `jakarta.servlet:jakarta.servlet-api` is `compileOnly` (only required if
  you mount `RealmFilter`)
- HTTP via `java.net.http.HttpClient` (built-in)
- RSA via `java.security.Signature` (built-in)
- Logging via `java.lang.System.Logger` (built-in)

Thread-safe — share one `Realm` per process.

## Example

See [`examples/server/`](examples/server) for a runnable HTTP server.

## Tests

```bash
./gradlew test
```

## License

MIT — see the [LICENSE](../LICENSE) at the repo root.

# @realmid/sdk — Java

Java SDK for verifying RealmID-issued JWTs. Sibling TypeScript SDK at
[`../ts/`](../ts), Go SDK at [`../go/`](../go).

## Install

Available on Maven Central (planned):

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
import dev.realmid.sdk.Claims;
import dev.realmid.sdk.Config;
import dev.realmid.sdk.ErrorCode;
import dev.realmid.sdk.Verifier;
import dev.realmid.sdk.VerifyException;

Verifier verifier = Verifier.create(
    Config.builder()
        .baseUrl("https://auth.realmid.dev")
        .audience("your-partner-audience")
        .build()
);

try {
    Claims claims = verifier.verify(accessToken);
    // claims.subject(), claims.tenantId(), claims.role(), claims.extra().get("...")
} catch (VerifyException e) {
    // e.getCode() in {MALFORMED, WRONG_ALGORITHM, BAD_SIGNATURE,
    //   WRONG_ISSUER, WRONG_AUDIENCE, EXPIRED, NOT_YET_VALID,
    //   UNKNOWN_KID, JWKS_FETCH_FAILED}
}
```

## Runtime

- Java 17+
- Single dependency: `com.fasterxml.jackson.core:jackson-databind`
- HTTP via `java.net.http.HttpClient` (built-in)
- RSA via `java.security.Signature` (built-in)

Thread-safe — share one `Verifier` per process.

## What's in scope

Just `verify()`. Other partner-facing operations (login, logout, refresh
rotation) are HTTP — call them with `HttpClient` directly. See the
[partner integration guide](https://realmid.dev/docs).

## Tests

```bash
./gradlew test
```

## License

MIT — see the [LICENSE](../LICENSE) at the repo root.

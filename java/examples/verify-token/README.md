# verify-token (Java)

Minimal example: verify a RealmID access token from the command line and
print its claims as JSON.

## Run

```bash
# from this directory
cd java/examples/verify-token
../../gradlew run --args="https://auth.realmid.dev your-partner-audience <paste-jwt-here>"
```

The example uses a Gradle composite build (`includeBuild("../..")`) so it
links against the sibling SDK source. In a real consumer you'd just
declare `implementation("dev.realmid:sdk:0.1.0")` and pull from Maven
Central.

## What it shows

- Constructing a `Verifier` once with `Verifier.create(Config.builder()...build())`.
- Calling `verifier.verify(token)` and catching `VerifyException`, whose
  `getCode()` is one of the `ErrorCode` enum values (`MALFORMED`,
  `WRONG_AUDIENCE`, `EXPIRED`, `UNKNOWN_KID`, …). Wire-level value is
  `e.getCode().wire()` — same string as the TS and Go SDKs.
- Reading the verified `Claims` (incl. realm extras `tenantId()`, `role()`,
  and any partner-supplied claims via `claims.extra()`).

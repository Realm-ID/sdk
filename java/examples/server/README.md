# realmid Java SDK — server example

Minimal HTTP server backed by `com.sun.net.httpserver.HttpServer` (no web
framework, no extra dependencies). Demonstrates:

- Constructing a `Realm` handle via `Realm.builder()`.
- Handling a login route with `realm.auth().login(...)`.
- Verifying access tokens with `realm.verify(token)` on every other route.

## Run

```sh
REALM_ID=01HXYZ REALM_API_KEY=rk_live_demo \
REALM_BASE_URL=https://auth.realmid.dev \
../../gradlew run
```

Then:

```sh
# Login (returns access token)
curl -X POST -d 'firebase-id-token-here' http://localhost:8080/login

# Authenticated request
curl -H 'Authorization: Bearer <access-token>' http://localhost:8080/whoami
```

For a real servlet container (Spring Boot / Jetty / Tomcat), mount
`dev.realmid.sdk.middleware.RealmFilter` instead of writing the routes
manually:

```java
RealmFilter filter = realm.middleware()
    .exemptPaths(List.of("/health", "/public/*"))
    .mfaProtectedPaths(List.of("/admin/*"))
    .buildFilter();
// ... register filter on every path
```

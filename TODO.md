# sdk/ — punch list

- [ ] `java/src/main/java/dev/realmid/sdk/.../HttpTransport` (+ `TenantsClientTest`) — Java SDK still bootstraps platform auth via `POST /auth/platform-token`, which was hard-cut in server v0.7.0 (ADR-051). Migrate to the two-endpoint flow (`POST /auth/login {grant_type:"platform_api_key"}` + `POST /auth/token`) like the Go/TS SDKs already do.

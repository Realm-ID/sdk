# Handoff — RealmID middleware extension hooks (a partner P0)

**To:** a partner / a partner integration
**From:** RealmID
**Date:** 2026-06-30
**Answers:** `a partner/docs/realmid-handoff-pending-asks-2026-06-30.md` §1 (P0)
**Design:** ADR-065 (`issuer/docs/adr/065-sdk-middleware-extension-hooks.md`)

## Ships in

| Component | Version | Carries |
|---|---|---|
| `github.com/Realm-ID/sdk/go` | **`go/v0.24.0`** | the middleware hooks + exported cookie helpers |
| issuer (`auth.realmid.dev`) | **v0.24.0** | `RealmConfig.origin_enforcement` on `realm.Info()` + `PATCH /config` |

> `go get github.com/Realm-ID/sdk/go@v0.24.0`

## What you can now delete

Your hand-rolled body-mode fork `api/internal/auth/bff/bff.go` — all of it.
`Realm.Middleware` now owns the **entire** auth flow (login / token /
logout / mfa / origin / cookie / response) in **default cookie mode**,
which restores session-survives-reload (your P0 symptom). You plug in via
four callbacks instead of forking the routes.

## Drop-in replacement

```go
mw := realm.Middleware(realmid.MiddlewareOptions{
    // default cookie mode → refresh lives in an HttpOnly cookie,
    // survives reload. (Set CookieDomain if SPA + BFF are cross-subdomain.)

    // (2) sync-install API-key substitution, was maybeSubstituteSyncInstall
    BeforeLogin: func(ctx context.Context, req *realmid.LoginRequest) error {
        if req.ProviderToken == bff.SyncInstallPlaceholder {
            req.ProviderToken = realSyncInstallKey
        }
        return nil
    },

    // (1) ADR-0001 lazy mirror reconcile — BEST-EFFORT: handle your own
    // errors and return nil (see "Concurrent-tab" below for why).
    OnAuthSuccess: func(ctx context.Context, ev *realmid.AuthSuccessEvent) error {
        if ev.Method == "sync_install" || ev.TenantID == "" || ev.UserID == "" {
            return nil // sync bots provisioned separately; tenant-picker has no tenant
        }
        name := tenantName(ev.Tenants, ev.TenantID) // "" on refresh → your Tenants.Get fallback
        _ = recon.EnsureTenantMirror(ctx, ev.TenantID, name)
        _ = recon.EnsureUserMirror(ctx, ev.TenantID, ev.UserID, displayName(ev), ev.Role)
        return nil // never fail the auth response
    },

    // optional: audit / metrics (observe-only — cannot change the response)
    OnAuthFailure: func(ctx context.Context, ev *realmid.AuthFailureEvent) {
        log.Warn("auth failure", "stage", ev.Stage, "code", ev.Err.Code)
    },

    // (3) origin guard — leave Auto (default); enable per realm in RI (below)
    OriginEnforcement: realmid.OriginEnforcementAuto,
})
```

Key win on the refresh path: `ev.UserID` is **already populated** — the
SDK verifies the freshly-minted access token and fills `sub` for you, so
you can delete the `realm.Verify(...) → claims.Subject` dance. `ev.Session`
and `ev.Tenants` are populated on login/mfa and empty on refresh (as
before, do your `Tenants.Get` name fallback on refresh).

(4) `tenant_id` is now forwarded from the login body into
`LoginRequest.TenantID` automatically — no action needed.

## Origin enforcement is now RI-driven (ask 3)

Don't hard-code the confused-deputy guard. Set it once per realm:

```
PATCH /platforms/{realmId}/config   { "origin_enforcement": "required" }
```

With `OriginEnforcement: Auto` (the default) the SDK reads that policy from
`realm.Info()` and enforces it on `/auth/*` — emitting your existing
`missing_origin` / `realm_origin_mismatch` codes (webapp parser unchanged).
On the **sync-agent** deployment (no browser Origin) set
`OriginEnforcement: realmid.OriginEnforcementOff`.

## Cookie helpers (ask 5)

If you ever keep custom routing, `realm.SetRefreshCookie` /
`ReadRefreshToken` / `ClearRefreshCookie` are exported now. But with the
full middleware you won't need them.

## Contract answers

**Concurrent-tab refresh — no grace window today.** The issuer rotates
refresh on every user `/auth/token` and the old token is immediately
invalid; `@realm-id/web` does not coordinate refresh across tabs
(notification-only, per-tab single-flight). Races are uncommon but real.
**This is why `OnAuthSuccess` must be best-effort** — throwing on the
refresh path strands the just-rotated session (old cookie already dead).
If you see multi-tab `refresh_invalid` after cutover, ping us — the fix is
an issuer-side grace window (separate ADR, not in this release).

**CSRF + cookie.** Keep your `@realm-id/web` double-submit CSRF **and** the
Origin check (defense in depth). Cookie posture is `HttpOnly; Secure;
SameSite=Lax`, name `realmid_refresh` (configurable), optional `Domain`.
`__Host-`/`__Secure-` prefix is **not** supported yet (conflicts with
`CookieDomain`); planned as an opt-in `CookiePrefix` — tell us if you want
it prioritized.

## One breaking change to know

If you ever set `OnAuthFailure` on the old SDK: its signature changed from
the response-owning `func(http.ResponseWriter, *http.Request, *RealmError)`
to the observe-only `func(ctx, *AuthFailureEvent)`. The middleware now
always writes the canonical `{error:{code,message}}` envelope.

## Suggested cutover

1. `go get …/sdk/go@v0.24.0`; mount `realm.Middleware(...)` (above);
   delete `bff.go`.
2. `PATCH /config { origin_enforcement: "required" }` on your realm; leave
   `Auto`. Set `Off` on the sync-agent build.
3. Keep the webapp CSRF double-submit.
4. Smoke: login → close/reopen tab → still logged in (the P0 fix).

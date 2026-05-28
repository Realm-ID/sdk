# @realmid/web-admin

Admin-UI SDK companion to [`@realmid/web`](../core). Wraps the
hand-written resource clients from
[`@realmid/sdk/internal`](../../../ts) on top of a thin transport shim
that delegates to `realm.fetch`, so the auth SDK keeps ownership of
Authorization-attach, refresh-on-401, and multi-tab logout sync — admin
calls inherit all of that for free.

## Quickstart

```ts
import { createRealm } from "@realmid/web";
import { createAdmin } from "@realmid/web-admin";
import { realmidBffPreset } from "@realmid/web-bff-realmid";

const realm = createRealm({
  baseUrl: "https://api.partner.com",
  ...realmidBffPreset(),
});

const admin = createAdmin(realm, {
  baseUrl: "https://api.partner.com",
});

const tenants = await admin.tenants.list();
const home = await admin.bff.home({ mode: "ops" });
const note = await admin.notes.create("plt_42", "investigated");
```

## Surface

| Namespace             | Source                                | Routing             |
|-----------------------|---------------------------------------|---------------------|
| `tenants` / `roles` / `domains` / `admin` | `@realmid/sdk/internal` | passthrough (`/api/...`) |
| `apiKeys`             | this package                          | passthrough         |
| `platforms`           | this package                          | passthrough         |
| `notes` / `signingKeys` | this package                        | BFF-direct (`/admin/...`) |
| `bff`                 | this package                          | BFF-direct (`/home`, `/tenants/{id}/full`) |
| `sessions`            | this package                          | BFF-direct (`/auth/sessions`) |
| `me`                  | this package                          | BFF-direct (`/me`, `/identity-providers`) |

The transport shim auto-detects BFF-direct paths by leading segment;
everything else gets the `/api` passthrough prefix.

## Why a separate package

Long-term plan: partner platforms build their own admin consoles on top
of `@realmid/web-admin` the same way they build their auth UIs on top
of `@realmid/web`. Keeping the admin surface in its own package means
partners can opt out of the larger admin dependency graph (and the
resource classes it pulls from `@realmid/sdk`) when they only need the
auth SDK.

## Known gaps

Tracked so the next reader doesn't have to grep the consuming UI:

- `apiKeys` is a **package-local** client (not the bundled
  `@realmid/sdk/internal` one, whose `displayName`/`scopes[]` shape
  predates the issuer contract). It targets the authoritative
  `/platforms/{id}/api-keys` shapes: `create({ scope, label? })` returns
  a one-time `value`; `list()` rows are `APIKeyListItem`
  (`id`/`prefix`/`role`/`created_at`/`last_used_at`/`revoked_at`, no
  `label`); `revoke(id)` soft-deletes. The `platformId` is passed
  per-call (not bound at `createAdmin`).
- `tenants.transferOwner(tenantId, newOwnerUserId)` takes a user id.
  Admin UIs that want email-based ownership transfer must resolve email
  → userId themselves first.
- `realm.config` patch is not in this package yet. Consumers that need
  it ship their own shim against `PATCH /platforms/{id}/config`.
- `RolesClient` is bound to a single `realmId` at `createAdmin`
  construction time. Cross-realm ops UIs that want a per-call `realmId`
  parameter need a follow-up.
- `bff.home()` and `bff.tenantFull()` return loose
  `{ [k: string]: unknown }` shapes; the rich response types live in
  `@realmid/sdk/internal` and the admin aggregates package types need a
  refresh before they can be re-exported here.

## Contract

The wire contract this package targets is documented in the BFF spec:
[`sdk/web/BFF-SPEC.md`](../../BFF-SPEC.md).

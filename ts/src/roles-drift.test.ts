import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HUMAN_ONLY_PERMISSIONS, confersAuthority, isRoleAssignableTo } from "./roles.js";

/**
 * DRIFT GATE for the two rules `roles.ts` copies out of the issuer.
 *
 * THE ISSUER WINS. `issuer/internal/realmrole/permissions.go` (the ADR-074
 * catalog + `IsMutatingPermission`/`ConfersAuthority`) and
 * `issuer/internal/realmrole/assignable.go` (`HumanOnlyPermissions`,
 * `AssignableToKind`) are authoritative. If this file goes red, the SDK is
 * wrong and the SDK is what changes.
 *
 * It binds in two independent ways, on purpose:
 *
 *  1. Against a PINNED FIXTURE below — a snapshot of the issuer's catalog,
 *     checked in as TEST DATA. This half runs everywhere, including a
 *     standalone `Realm-ID/sdk` CI checkout where no issuer source exists. It
 *     proves the SDK's colon-derived action rule classifies every real catalog
 *     entry exactly as the issuer's `Action != "read"` rule does.
 *  2. Against the LIVE issuer source, when a sibling checkout is reachable
 *     (the `Realm-ID/project` workspace layout, or `REALMID_ISSUER_DIR`). This
 *     is the half that catches the fixture going stale.
 *
 * Half 2 cannot bind in `Realm-ID/sdk`'s own CI, which checks out one repo —
 * so it says so out loud rather than passing quietly, and `REALMID_DRIFT_STRICT=1`
 * turns "issuer not reachable" into a failure for any runner that CAN reach it.
 * Wiring that checkout into `sdk`'s CI is filed in `sdk/TODO.md`.
 */

// ---- The pinned snapshot (regenerate from the issuer, never hand-edit) ----

interface CatalogEntry {
  key: string;
  resource: string;
  action: string;
}

/** `realmrole.Catalog`, as of issuer @ 2026-08-30. 31 entries (ADR-074). */
const ISSUER_CATALOG: CatalogEntry[] = [
  { key: "users:read", resource: "users", action: "read" },
  { key: "users:manage", resource: "users", action: "manage" },
  { key: "invitations:read", resource: "invitations", action: "read" },
  { key: "invitations:manage", resource: "invitations", action: "manage" },
  { key: "roles:read", resource: "roles", action: "read" },
  { key: "tenants:read", resource: "tenants", action: "read" },
  { key: "tenants:manage", resource: "tenants", action: "manage" },
  { key: "service_accounts:read", resource: "service_accounts", action: "read" },
  { key: "service_accounts:manage", resource: "service_accounts", action: "manage" },
  { key: "platform_api_keys:read", resource: "platform_api_keys", action: "read" },
  { key: "platform_api_keys:manage", resource: "platform_api_keys", action: "manage" },
  { key: "identity_providers:read", resource: "identity_providers", action: "read" },
  { key: "identity_providers:manage", resource: "identity_providers", action: "manage" },
  { key: "sources:read", resource: "sources", action: "read" },
  { key: "sources:manage", resource: "sources", action: "manage" },
  { key: "federation:read", resource: "federation", action: "read" },
  { key: "federation:manage", resource: "federation", action: "manage" },
  { key: "signing_keys:read", resource: "signing_keys", action: "read" },
  { key: "signing_keys:rotate", resource: "signing_keys", action: "rotate" },
  { key: "domains:read", resource: "domains", action: "read" },
  { key: "domains:manage", resource: "domains", action: "manage" },
  { key: "sessions:revoke", resource: "sessions", action: "revoke" },
  { key: "audit:read", resource: "audit", action: "read" },
  { key: "platform:config", resource: "platform", action: "config" },
  { key: "otp:read", resource: "otp", action: "read" },
  { key: "integrations:read", resource: "integrations", action: "read" },
  { key: "integrations:manage", resource: "integrations", action: "manage" },
  { key: "org_grants:read", resource: "org_grants", action: "read" },
  { key: "org_grants:manage", resource: "org_grants", action: "manage" },
  { key: "user_api_keys:read", resource: "user_api_keys", action: "read" },
  { key: "user_api_keys:manage", resource: "user_api_keys", action: "manage" },
];

/** `realmrole.HumanOnlyPermissions` (ADR-081 §2.3), sorted. */
const ISSUER_HUMAN_ONLY = [
  "domains:manage",
  "federation:manage",
  "platform:config",
  "signing_keys:rotate",
];

// ---- Half 1: the SDK agrees with the pinned catalog, everywhere ----

test("drift: the SDK's colon-derived action equals the issuer's catalog Action", () => {
  // This is the invariant that makes `confersAuthority` correct WITHOUT the
  // SDK shipping a copy of the catalog: for every real entry, the substring
  // after the colon IS the issuer's `Action` field. Break it in the issuer and
  // this fixture stops matching (half 2), and this assertion pins why it
  // matters.
  for (const p of ISSUER_CATALOG) {
    assert.equal(p.key, `${p.resource}:${p.action}`, `catalog key ${p.key} is not resource:action`);
    const expected = p.action !== "read";
    assert.equal(
      confersAuthority({ permissions: [p.key] }),
      expected,
      `${p.key}: issuer says confersAuthority=${expected}`,
    );
    assert.equal(
      confersAuthority({ permissions: [p.key] }, { catalog: ISSUER_CATALOG.map((c) => ({ ...c, label: "" })) }),
      expected,
      `${p.key}: catalog-driven classification must match`,
    );
  }
});

test("drift: the catalog has the 31 entries ADR-074 pins", () => {
  // The issuer pins the count AND the key set (TestCatalogSize + catalogKeys).
  // A swap that keeps the count is caught by half 2's set comparison.
  assert.equal(ISSUER_CATALOG.length, 31);
});

test("drift: HUMAN_ONLY_PERMISSIONS matches the pinned issuer set", () => {
  assert.deepEqual([...HUMAN_ONLY_PERMISSIONS].sort(), ISSUER_HUMAN_ONLY);
  // and every one of them is a real catalog key
  const keys = new Set(ISSUER_CATALOG.map((p) => p.key));
  for (const p of ISSUER_HUMAN_ONLY) assert.ok(keys.has(p), `${p} is not in the catalog`);
});

test("drift: every human-only permission is one a service principal is refused", () => {
  for (const p of ISSUER_HUMAN_ONLY) {
    assert.equal(
      isRoleAssignableTo({ name: "custom", permissions: [p], assignable_to: ["human", "service"] }, "service"),
      false,
    );
  }
});

// ---- Half 2: the pinned fixture still matches the live issuer source ----

function findIssuerRealmRoleDir(): string | null {
  const explicit = process.env["REALMID_ISSUER_DIR"];
  if (explicit) {
    const p = resolve(explicit, "internal/realmrole");
    return existsSync(p) ? p : null;
  }
  // sdk/ts/src -> sdk/ts -> sdk -> <workspace>
  const here = dirname(fileURLToPath(import.meta.url));
  const p = resolve(here, "../../../issuer/internal/realmrole");
  return existsSync(p) ? p : null;
}

function parseIssuer(dir: string): { catalog: CatalogEntry[]; humanOnly: string[] } {
  const perms = readFileSync(resolve(dir, "permissions.go"), "utf8");
  const assignable = readFileSync(resolve(dir, "assignable.go"), "utf8");

  const consts = new Map<string, string>();
  for (const m of perms.matchAll(/^\s*(Perm[A-Za-z0-9_]+)\s*=\s*"([^"]+)"/gm)) {
    consts.set(m[1] as string, m[2] as string);
  }
  assert.ok(consts.size >= 25, `parsed only ${consts.size} Perm consts — the regex has stopped matching`);

  const block = perms.match(/var Catalog = \[\]Permission\{([\s\S]*?)\n\}/);
  assert.ok(block, "could not locate `var Catalog` in permissions.go");
  const catalog: CatalogEntry[] = [];
  for (const m of (block[1] as string).matchAll(/\{(Perm[A-Za-z0-9_]+),\s*"([^"]*)",\s*"([^"]*)",/g)) {
    const key = consts.get(m[1] as string);
    assert.ok(key, `catalog names ${m[1]}, which is not a declared Perm const`);
    catalog.push({ key, resource: m[2] as string, action: m[3] as string });
  }
  assert.ok(catalog.length >= 25, `parsed only ${catalog.length} catalog entries — the regex has stopped matching`);

  const hoBlock = assignable.match(/var HumanOnlyPermissions = map\[string\]struct\{\}\{([\s\S]*?)\n\}/);
  assert.ok(hoBlock, "could not locate `var HumanOnlyPermissions` in assignable.go");
  const humanOnly: string[] = [];
  for (const m of (hoBlock[1] as string).matchAll(/^\s*(Perm[A-Za-z0-9_]+):/gm)) {
    const key = consts.get(m[1] as string);
    assert.ok(key, `HumanOnlyPermissions names ${m[1]}, which is not a declared Perm const`);
    humanOnly.push(key);
  }
  assert.ok(humanOnly.length > 0, "parsed zero human-only permissions — the regex has stopped matching");
  return { catalog, humanOnly: humanOnly.sort() };
}

test("drift: the pinned fixture equals the LIVE issuer source", (t) => {
  const dir = findIssuerRealmRoleDir();
  if (!dir) {
    // Not a pass on the merits and not silent about it. Half 1 above still
    // bound; only the fixture-staleness check did not.
    const msg =
      "issuer checkout not reachable — the fixture-staleness half did NOT run. " +
      "Set REALMID_ISSUER_DIR=<path to Realm-ID/issuer> to bind it.";
    if (process.env["REALMID_DRIFT_STRICT"]) assert.fail(msg);
    t.diagnostic(msg);
    return;
  }
  const live = parseIssuer(dir);
  assert.deepEqual(live.catalog, ISSUER_CATALOG, "the ADR-074 catalog moved; regenerate ISSUER_CATALOG");
  assert.deepEqual(live.humanOnly, ISSUER_HUMAN_ONLY, "HumanOnlyPermissions moved; update roles.ts AND this fixture");
});

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HUMAN_ONLY_PERMISSIONS,
  NON_ASSIGNABLE_ROLES,
  confersAuthority,
  isRoleAssignableTo,
  isRoleSeatable,
  PRINCIPAL_KINDS,
} from "./roles.js";
import { SSO_DOMAIN_METHODS, SSO_DOMAIN_STATUSES } from "./sso-domains.js";

/**
 * DRIFT GATE for the two rules `roles.ts` copies out of the issuer.
 *
 * THE ISSUER WINS. `issuer/internal/realmrole/permissions.go` (the ADR-074
 * catalog + `IsMutatingPermission`/`ConfersAuthority`) and
 * `issuer/internal/realmrole/assignable.go` (`HumanOnlyPermissions`,
 * `AssignableToKind`) and `issuer/internal/realmrole/store.go`
 * (`NonAssignableRoles`), and `issuer/internal/tenantdomain/tenantdomain.go`
 * (`IsValidMethod` / `IsValidStatus`) are authoritative.
 *
 * EVERY set this SDK mirrors is compared here, by SET EQUALITY rather than
 * membership, so an extra entry fails as loudly as a missing one. That rule was
 * added after `NON_ASSIGNABLE_ROLES` shipped a member short while this gate was
 * green: the gate covered two of the mirrored sets and said nothing about the
 * third, which is indistinguishable from having no gate for that set at all. If this file goes red, the SDK is
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

/**
 * `realmrole.NonAssignableRoles` (store.go), sorted — the roles nobody is
 * granted through the invite/assignment surface.
 *
 * DELIBERATELY NOT `ProtectedRoles`, which the issuer keeps as a separate map
 * meaning "cannot be disabled or deleted". The two overlap but `member` is
 * protected AND the most assignable role there is, so reading one for the other
 * empties every picker.
 */
const ISSUER_NON_ASSIGNABLE = ["owner", "platform_api", "platform_mgmt_api"];

/** `realmrole.AssignableKinds` (ADR-071 `users.kind`), sorted. */
const ISSUER_ASSIGNABLE_KINDS = ["human", "service"];

/** `tenantdomain.IsValidMethod`'s five cases (ADR-094), sorted. */
const ISSUER_SSO_METHODS = [
  "dns_txt",
  "html_file",
  "meta_tag",
  "platform_approval",
  "self_asserted",
];

/** `tenantdomain.IsValidStatus`'s seven cases (ADR-094), sorted. */
const ISSUER_SSO_STATUSES = [
  "active",
  "claimed",
  "failed",
  "pending",
  "rejected",
  "revoked",
  "suspended",
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

test("drift: NON_ASSIGNABLE_ROLES matches the pinned issuer set", () => {
  assert.deepEqual([...NON_ASSIGNABLE_ROLES].sort(), ISSUER_NON_ASSIGNABLE);
  // and the picker predicate actually applies it, for both kinds
  for (const name of ISSUER_NON_ASSIGNABLE) {
    assert.equal(isRoleSeatable({ name }, "human"), false, name);
    assert.equal(isRoleSeatable({ name }, "service"), false, name);
  }
});

test("drift: PRINCIPAL_KINDS matches the pinned issuer set", () => {
  assert.deepEqual([...PRINCIPAL_KINDS].sort(), ISSUER_ASSIGNABLE_KINDS);
});

test("drift: the SSO domain vocabularies match the pinned issuer sets", () => {
  assert.deepEqual([...SSO_DOMAIN_METHODS].sort(), ISSUER_SSO_METHODS);
  assert.deepEqual([...SSO_DOMAIN_STATUSES].sort(), ISSUER_SSO_STATUSES);
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

function findIssuerDir(): string | null {
  const explicit = process.env["REALMID_ISSUER_DIR"];
  if (explicit) return existsSync(resolve(explicit, "internal")) ? resolve(explicit) : null;
  // sdk/ts/src -> sdk/ts -> sdk -> <workspace>
  const here = dirname(fileURLToPath(import.meta.url));
  const p = resolve(here, "../../../issuer");
  return existsSync(resolve(p, "internal/realmrole")) ? p : null;
}

/**
 * Keys of a Go map literal, addressed by its VARIABLE NAME.
 *
 * Anchored on the name and never on `map[string]bool{` alone: `store.go`
 * declares `ProtectedRoles` beside `NonAssignableRoles` with an identical type
 * and a different meaning, and it contains `member`. A loose match would swap
 * "cannot be deleted" for "cannot be held" and silently empty every picker.
 */
function issuerMapKeys(src: string, varName: string, where: string): string[] {
  const block = src.match(
    new RegExp(`var ${varName} = map\\[string\\](?:bool|struct\\{\\})\\{([\\s\\S]*?)\\n\\}`),
  );
  assert.ok(block, `could not locate \`var ${varName}\` in ${where}`);
  const keys = [...(block[1] as string).matchAll(/"([a-z0-9_:]+)":/g)].map((m) => m[1] as string);
  assert.ok(keys.length > 0, `parsed zero keys from ${varName} — the regex has stopped matching`);
  return keys.sort();
}

/** The string cases of a Go `switch` inside the named func — a closed vocabulary. */
function issuerSwitchCases(src: string, funcName: string, where: string): string[] {
  const fn = src.match(new RegExp(`func ${funcName}\\([^)]*\\) bool \\{([\\s\\S]*?)\\n\\}`));
  assert.ok(fn, `could not locate \`func ${funcName}\` in ${where}`);
  const caseLine = (fn[1] as string).match(/\n\tcase ([\s\S]*?):/);
  assert.ok(caseLine, `\`${funcName}\` has no case clause`);
  // The cases name Go consts (MethodDNSTXT, StatusClaimed); resolve each to its
  // declared string literal rather than guessing from the identifier.
  const idents = (caseLine[1] as string).split(",").map((x) => x.trim()).filter(Boolean);
  assert.ok(idents.length > 0, `parsed zero cases from ${funcName} — the regex has stopped matching`);
  const consts = new Map<string, string>();
  for (const m of src.matchAll(/^\s*([A-Z][A-Za-z0-9_]*)\s+(?:Method|Status)\s*=\s*"([^"]+)"/gm)) {
    consts.set(m[1] as string, m[2] as string);
  }
  return idents
    .map((id) => {
      const v = consts.get(id);
      assert.ok(v, `${funcName} names ${id}, which is not a declared const in ${where}`);
      return v;
    })
    .sort();
}

function parseIssuer(root: string): {
  catalog: CatalogEntry[];
  humanOnly: string[];
  nonAssignable: string[];
  assignableKinds: string[];
  ssoMethods: string[];
  ssoStatuses: string[];
} {
  const dir = resolve(root, "internal/realmrole");
  const perms = readFileSync(resolve(dir, "permissions.go"), "utf8");
  const assignable = readFileSync(resolve(dir, "assignable.go"), "utf8");
  const store = readFileSync(resolve(dir, "store.go"), "utf8");
  const td = readFileSync(resolve(root, "internal/tenantdomain/tenantdomain.go"), "utf8");

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

  const nonAssignable = issuerMapKeys(store, "NonAssignableRoles", "store.go");
  assert.ok(
    !nonAssignable.includes("member"),
    "parsed `member` as non-assignable — the reader matched ProtectedRoles, not NonAssignableRoles",
  );

  const kindsBlock = assignable.match(/var AssignableKinds = \[\]string\{([^}]*)\}/);
  assert.ok(kindsBlock, "could not locate `var AssignableKinds` in assignable.go");
  const kindConsts = new Map<string, string>();
  for (const m of assignable.matchAll(/^\s*(Assignable[A-Za-z]+)\s*=\s*"([^"]+)"/gm)) {
    kindConsts.set(m[1] as string, m[2] as string);
  }
  const assignableKinds = (kindsBlock[1] as string)
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((id) => {
      const v = kindConsts.get(id);
      assert.ok(v, `AssignableKinds names ${id}, which is not a declared const`);
      return v;
    })
    .sort();
  assert.ok(assignableKinds.length > 0, "parsed zero assignable kinds — the regex has stopped matching");

  return {
    catalog,
    humanOnly: humanOnly.sort(),
    nonAssignable,
    assignableKinds,
    ssoMethods: issuerSwitchCases(td, "IsValidMethod", "tenantdomain.go"),
    ssoStatuses: issuerSwitchCases(td, "IsValidStatus", "tenantdomain.go"),
  };
}

test("drift: the pinned fixture equals the LIVE issuer source", (t) => {
  const dir = findIssuerDir();
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
  assert.deepEqual(
    live.nonAssignable,
    ISSUER_NON_ASSIGNABLE,
    "NonAssignableRoles moved; update NON_ASSIGNABLE_ROLES in roles.ts AND this fixture",
  );
  assert.deepEqual(
    live.assignableKinds,
    ISSUER_ASSIGNABLE_KINDS,
    "AssignableKinds moved; update PRINCIPAL_KINDS in roles.ts AND this fixture",
  );
  assert.deepEqual(
    live.ssoMethods,
    ISSUER_SSO_METHODS,
    "tenantdomain methods moved; update SSO_DOMAIN_METHODS AND this fixture",
  );
  assert.deepEqual(
    live.ssoStatuses,
    ISSUER_SSO_STATUSES,
    "tenantdomain statuses moved; update SSO_DOMAIN_STATUSES AND this fixture",
  );
});

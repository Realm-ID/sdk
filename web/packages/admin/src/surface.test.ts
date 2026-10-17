/**
 * The web-admin package's own boundary rules:
 *
 *  - A1: the wave-1 role predicates are re-exported, and the ASSIGNABLE /
 *    SEATABLE split survives the trip. Collapsing them is how a picker starts
 *    offering `owner`.
 *  - A4: there is exactly ONE envelope implementation in the workspace.
 *  - A3: `federationBindings` / `ssoDomains` are wired onto `createAdmin`.
 *  - C1: the base-realm-staff-only notes surface is not on the partner-facing
 *    entry point.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import * as admin from "./index.js";
import * as ops from "./internal.js";
import { isRoleAssignableTo, isRoleSeatable, rolesAssignableTo, confersAuthority } from "@realm-id/sdk";

const HERE = dirname(fileURLToPath(import.meta.url));

// ---- ADR-115: bring-your-own phone delivery ----

test("SPEC6_16 createAdmin wires the realm messaging client and the helpers are re-exported", async () => {
  const sdk = await import("@realm-id/sdk");
  assert.equal(admin.isInvalidChannelConfig, sdk.isInvalidChannelConfig);
  assert.equal(admin.isChannelValidationFailed, sdk.isChannelValidationFailed);
  assert.equal(admin.isChannelNotConfigured, sdk.isChannelNotConfigured);
  assert.equal(admin.isPhoneOtpRateLimited, sdk.isPhoneOtpRateLimited);
  assert.equal(admin.phoneOtpConfig, sdk.phoneOtpConfig);
  assert.equal(admin.DELIVERY_MODE_WHATSAPP, "whatsapp");

  const calls: Array<{ method: string; url: string }> = [];
  const realm = {
    async fetch(url: string | URL | Request, init: RequestInit = {}) {
      calls.push({ method: init.method ?? "GET", url: String(url) });
      return new Response(JSON.stringify({ status: "deleted" }), { status: 200, headers: { "content-type": "application/json" } });
    },
  } as unknown as import("@realm-id/web").Realm;
  const a = admin.createAdmin(realm, { baseUrl: "https://bff.test", realmId: "r1" });
  assert.equal(typeof a.messaging.putSms, "function");
  assert.equal(typeof a.messaging.putWhatsApp, "function");
  const out = await a.messaging.delete("sms");
  assert.equal(out.status, "deleted");
  const hit = calls.find((c) => c.method === "DELETE");
  assert.ok(hit && /\/platforms\/r1\/messaging\/sms$/.test(hit.url), JSON.stringify(calls));
});

// ---- A1: the predicates, and the split ----

test("the wave-1 predicates are re-exported by identity, not re-implemented", async () => {
  assert.equal(admin.isRoleAssignableTo, isRoleAssignableTo);
  assert.equal(admin.isRoleSeatable, isRoleSeatable);
  assert.equal(admin.rolesAssignableTo, rolesAssignableTo);
  assert.equal(admin.confersAuthority, confersAuthority);
  assert.equal(admin.NON_ASSIGNABLE_ROLES, (await import("@realm-id/sdk")).NON_ASSIGNABLE_ROLES);
});

test("SEATABLE is stricter than ASSIGNABLE — `owner` is the case that proves it", () => {
  const owner = { name: "owner", assignable_to: [] as ("human"|"service")[], permissions: [] as string[] };
  // `human`, not `user`: PRINCIPAL_KINDS mirrors `realmrole.AssignableKinds`.
  assert.equal(admin.isRoleAssignableTo(owner, "human"), true,
    "the server mirror has no name guard — an empty assignable_to means ANY");
  assert.equal(admin.isRoleSeatable(owner, "human"), false,
    "a picker must never offer owner; if this flips, the split has been collapsed");
});

test("a picker built on rolesAssignableTo drops owner and the bot roles", () => {
  const roles = [
    { name: "owner", assignable_to: [] as ("human"|"service")[], permissions: [] as string[] },
    { name: "admin", assignable_to: [] as ("human"|"service")[], permissions: [] as string[] },
    { name: "member", assignable_to: [] as ("human"|"service")[], permissions: [] as string[] },
    { name: "platform_api", assignable_to: [] as ("human"|"service")[], permissions: [] as string[] },
    { name: "platform_mgmt_api", assignable_to: [] as ("human"|"service")[], permissions: [] as string[] },
  ];
  assert.deepEqual(
    admin.rolesAssignableTo(roles, "human").map((r) => r.name),
    ["admin", "member"],
  );
});

// ---- A4: one envelope implementation ----

test("the envelope primitives are re-exported from @realm-id/sdk", async () => {
  const sdk = await import("@realm-id/sdk");
  assert.equal(admin.unwrapData, sdk.unwrapData);
  assert.equal(admin.parseErrorEnvelope, sdk.parseErrorEnvelope);
});

test("this package declares NO local unwrapData / parseErrorEnvelope", () => {
  const offenders: string[] = [];
  for (const f of readdirSync(HERE)) {
    if (!f.endsWith(".ts") || f.endsWith(".test.ts")) continue;
    const src = readFileSync(join(HERE, f), "utf8");
    if (/^\s*(export\s+)?function\s+(unwrapData|parseErrorEnvelope)\b/m.test(src)) offenders.push(f);
  }
  assert.deepEqual(offenders, [], `a local envelope copy is back in: ${offenders.join(", ")}`);
});

// ---- A3: the new resources are wired ----

test("createAdmin exposes ssoDomains and federationBindings", () => {
  const realm = { async fetch() { return new Response("{}", { status: 200 }); } };
  const a = admin.createAdmin(realm as never, { baseUrl: "https://bff.example", realmId: "p1" });
  assert.ok(a.ssoDomains, "admin.ssoDomains missing");
  assert.ok(a.federationBindings, "admin.federationBindings missing");
  assert.equal(typeof a.ssoDomains.listForPlatform, "function");
  assert.equal(typeof a.federationBindings.create, "function");
});

// ---- C1: notes are staff-only and off the partner entry point ----

test("PlatformNotesClient is NOT on the partner-facing entry point", () => {
  assert.equal(
    (admin as unknown as Record<string, unknown>).PlatformNotesClient,
    undefined,
    "/admin/platforms/{id}/notes is base-realm-staff-only — a partner can only 403 against it",
  );
});

test("PlatformNotesClient IS reachable on the ops subpath", () => {
  assert.equal(typeof ops.PlatformNotesClient, "function");
  assert.equal(typeof ops.createOpsAdmin, "function");
});

test("admin.notes is gone from the partner Admin object", () => {
  const realm = { async fetch() { return new Response("{}", { status: 200 }); } };
  const a = admin.createAdmin(realm as never, { baseUrl: "https://bff.example" });
  assert.equal((a as unknown as Record<string, unknown>).notes, undefined);
});

test("createOpsAdmin still carries the whole partner surface plus notes", () => {
  const realm = { async fetch() { return new Response("{}", { status: 200 }); } };
  const o = ops.createOpsAdmin(realm as never, { baseUrl: "https://bff.example" });
  assert.ok(o.notes, "the ops entry point must still expose notes");
  assert.ok(o.tenants, "the ops entry point is a superset, not a replacement");
});

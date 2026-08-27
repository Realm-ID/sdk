import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createAdmin } from "./index.js";

/**
 * These drive `admin.scopes.*` through the REAL wiring — createAdmin →
 * realmFetchAsHttpClient → the ts SDK's ScopesClient — rather than
 * constructing the resource class directly.
 *
 * That is deliberate. `0.8.20`'s changelog says it "wires the ts SDK's
 * ScopesClient onto the admin handle", and nothing tested the wiring: no test
 * in this package went through `createAdmin` at all, so a handle that dropped
 * `scopes`, or passed the wrong realm id, or lost the `/api` prefix, would have
 * shipped green. Constructing ScopesClient here would re-test the ts package's
 * own tests and skip the only thing this package contributes.
 */

interface CapturedCall {
  url: string;
  init: RequestInit & { anonymous?: boolean };
}

function makeAdmin(payload: unknown, realmId?: string) {
  const calls: CapturedCall[] = [];
  const realm = {
    async fetch(url: string | URL | Request, init: RequestInit & { anonymous?: boolean } = {}) {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ data: payload }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  } as unknown as import("@realm-id/web").Realm;

  const admin = createAdmin(realm, { baseUrl: "https://api.partner.com", realmId });
  return { admin, calls };
}

function bodyOf(call: CapturedCall): Record<string, unknown> {
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

describe("admin.scopes", () => {
  // ADR-097 §G's `remove` had three tests here. It was DELETED outright by
  // ADR-100 D10 — retiring a scope needs no server-side write, because the
  // partner simply stops emitting the string in the `role_permissions` list it
  // now supplies at every token mint, and a stale entry in a stored cap never
  // survives an intersection again. Do not restore them: there is nothing to
  // call in any repo.

  it("rename POSTs from + to to /platforms/{id}/scopes/rename", async () => {
    const { admin, calls } = makeAdmin({ from: "a", to: "b", dry_run: false, keys: 2, scopes: 2 }, "p1");
    await admin.scopes.rename({ from: "a", to: "b" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "https://api.partner.com/api/platforms/p1/scopes/rename");
    assert.equal(calls[0]!.init.method, "POST");
    assert.deepEqual(bodyOf(calls[0]!), { from: "a", to: "b" });
  });

  it("rename carries dry_run=true in the QUERY, not the body", async () => {
    const { admin, calls } = makeAdmin({ from: "a", to: "b", dry_run: true, keys: 2, roles: 0 }, "p1");
    const out = await admin.scopes.rename({ from: "a", to: "b", dryRun: true });
    assert.equal(calls[0]!.url, "https://api.partner.com/api/platforms/p1/scopes/rename?dry_run=true");
    assert.equal(bodyOf(calls[0]!).dry_run, undefined);
    assert.equal(out.dry_run, true);
  });

  it("rename omits dry_run entirely when not requested", async () => {
    const { admin, calls } = makeAdmin({ from: "a", to: "b", dry_run: false, keys: 1, roles: 0 }, "p1");
    await admin.scopes.rename({ from: "a", to: "b" });
    assert.ok(!calls[0]!.url.includes("dry_run"), `unexpected dry_run in ${calls[0]!.url}`);
  });

  it("defaults the realm id to `current` when createAdmin is given none", async () => {
    // The handle is normally built without an explicit id and the BFF rewrites
    // the path; a wrong default would send every realm's rename at one id.
    const { admin, calls } = makeAdmin({ from: "a", to: "b", dry_run: false, keys: 0, roles: 0 });
    await admin.scopes.rename({ from: "a", to: "b" });
    assert.equal(calls[0]!.url, "https://api.partner.com/api/platforms/current/scopes/rename");
  });
});

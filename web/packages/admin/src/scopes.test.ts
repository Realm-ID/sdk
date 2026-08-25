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
  it("remove POSTs scope + on_empty to /platforms/{id}/scopes/remove", async () => {
    const { admin, calls } = makeAdmin(
      { scope: "reports:read", dry_run: false, on_empty: "refuse", outcome: "applied", keys: 3, revoked: 0, emptied: [] },
      "p1",
    );

    const out = await admin.scopes.remove({ scope: "reports:read", onEmpty: "refuse" });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "https://api.partner.com/api/platforms/p1/scopes/remove");
    assert.equal(calls[0]!.init.method, "POST");
    assert.deepEqual(bodyOf(calls[0]!), { scope: "reports:read", on_empty: "refuse" });
    assert.equal(out.outcome, "applied");
    assert.deepEqual(out.emptied, []);
  });

  it("remove carries dry_run=true in the QUERY, not the body", async () => {
    // The preview is the only surface that can hand back `emptied` — a 409
    // error envelope carries no payload — so a dry run that silently became a
    // write is the sharpest failure this client has.
    const emptied = [{ id: "k1", user_id: "u1", label: "ci-bot" }];
    const { admin, calls } = makeAdmin(
      { scope: "reports:read", dry_run: true, on_empty: "refuse", outcome: "refused", keys: 2, revoked: 0, emptied },
      "p1",
    );

    const out = await admin.scopes.remove({ scope: "reports:read", dryRun: true });

    assert.equal(calls[0]!.url, "https://api.partner.com/api/platforms/p1/scopes/remove?dry_run=true");
    assert.equal(bodyOf(calls[0]!).dry_run, undefined);
    assert.equal(out.outcome, "refused");
    assert.deepEqual(out.emptied, emptied);
  });

  it("remove omits dry_run entirely when not requested", async () => {
    const { admin, calls } = makeAdmin(
      { scope: "s", dry_run: false, on_empty: "revoke", outcome: "applied", keys: 1, revoked: 1, emptied: [] },
      "p1",
    );
    await admin.scopes.remove({ scope: "s", onEmpty: "revoke" });
    assert.ok(!calls[0]!.url.includes("dry_run"), `unexpected dry_run in ${calls[0]!.url}`);
  });

  it("rename POSTs from + to to /platforms/{id}/scopes/rename", async () => {
    const { admin, calls } = makeAdmin({ from: "a", to: "b", dry_run: false, keys: 2, scopes: 2 }, "p1");
    await admin.scopes.rename({ from: "a", to: "b" });
    assert.equal(calls[0]!.url, "https://api.partner.com/api/platforms/p1/scopes/rename");
    assert.deepEqual(bodyOf(calls[0]!), { from: "a", to: "b" });
  });

  it("defaults the realm id to `current` when createAdmin is given none", async () => {
    // The handle is normally built without an explicit id and the BFF rewrites
    // the path; a wrong default would send every realm's removal at one id.
    const { admin, calls } = makeAdmin(
      { scope: "s", dry_run: false, on_empty: "refuse", outcome: "applied", keys: 0, revoked: 0, emptied: [] },
    );
    await admin.scopes.remove({ scope: "s" });
    assert.equal(calls[0]!.url, "https://api.partner.com/api/platforms/current/scopes/remove");
  });
});

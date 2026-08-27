import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { UserApiKeysClient } from "@realm-id/sdk/internal";
import type { HttpLike } from "./transport.js";
import type { RequestOptions } from "@realm-id/sdk/internal";

interface Captured {
  opts: RequestOptions;
}

function makeHttp(response: unknown): { http: HttpLike; calls: Captured[] } {
  const calls: Captured[] = [];
  const http: HttpLike = {
    async request<T>(opts: RequestOptions): Promise<T> {
      calls.push({ opts });
      return response as T;
    },
  };
  return { http, calls };
}

// The client itself is `@realm-id/sdk`'s (SPEC §6.6) — these cover the wiring
// this package is responsible for: that `admin.userApiKeys` targets the ADR-084
// route segment and NOT the platform-key one, and that ids are encoded.
describe("UserApiKeysClient via web-admin transport (ADR-084)", () => {
  const asClient = (http: HttpLike) =>
    new UserApiKeysClient(http as unknown as ConstructorParameters<typeof UserApiKeysClient>[0]);

  it("list GETs the user-api-keys segment, distinct from platform api-keys", async () => {
    const { http, calls } = makeHttp({ items: [{ id: "k1", prefix: "uk_live_ab" }] });
    const out = await asClient(http).list("t 1", "u/2");
    assert.equal(calls[0]!.opts.method, "GET");
    assert.equal(calls[0]!.opts.path, "/tenants/t%201/users/u%2F2/user-api-keys");
    assert.ok(!calls[0]!.opts.path.includes("/platforms/"));
    assert.equal(out[0]!.id, "k1");
  });

  it("create POSTs the mint body and returns the one-time value", async () => {
    const { http, calls } = makeHttp({ id: "k2", value: "uk_live_secret", label: "ci" });
    const out = await asClient(http).create("t1", "u1", {
      label: "ci",
      org_scope: "selected",
      uncapped: false,
      permissions_cap: ["users:read"],
    });
    assert.equal(calls[0]!.opts.method, "POST");
    assert.equal(calls[0]!.opts.path, "/tenants/t1/users/u1/user-api-keys");
    // ADR-100: `uncapped` is on the wire even though it is FALSE — the value a
    // conditional spread would drop. An absent `uncapped` used to mean "grant
    // the holder's full authority", so the field being unconditional is the
    // whole mechanism, not a detail of the serialiser.
    assert.deepEqual(calls[0]!.opts.body, {
      label: "ci",
      uncapped: false,
      org_scope: "selected",
      permissions_cap: ["users:read"],
    });
    assert.equal(out.value, "uk_live_secret");
  });

  it("update PUTs the same write body at the key's own path", async () => {
    const { http, calls } = makeHttp({ id: "k2", label: "ci" });
    await asClient(http).update("t1", "u1", "k/3", { label: "ci", uncapped: true });
    assert.equal(calls[0]!.opts.method, "PUT");
    assert.equal(calls[0]!.opts.path, "/tenants/t1/users/u1/user-api-keys/k%2F3");
    assert.deepEqual(calls[0]!.opts.body, { label: "ci", uncapped: true });
  });

  it("revoke DELETEs the key path", async () => {
    const { http, calls } = makeHttp(undefined);
    await asClient(http).revoke("t1", "u1", "k/3");
    assert.equal(calls[0]!.opts.method, "DELETE");
    assert.equal(calls[0]!.opts.path, "/tenants/t1/users/u1/user-api-keys/k%2F3");
  });
});

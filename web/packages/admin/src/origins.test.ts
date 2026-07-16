import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { OriginsClient } from "./origins.js";
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

describe("OriginsClient", () => {
  it("list unwraps { items } and hits GET /platforms/{id}/origins", async () => {
    const rows = [{ id: "o1", domain: "app.acme.com", entity_type: "realm", entity_id: "p1", created_at: 1 }];
    const { http, calls } = makeHttp({ items: rows });
    const client = new OriginsClient(http);
    const out = await client.list("p1");
    assert.deepEqual(out, rows);
    assert.equal(calls[0]!.opts.method, "GET");
    assert.equal(calls[0]!.opts.path, "/platforms/p1/origins");
  });

  it("list tolerates a missing items key", async () => {
    const { http } = makeHttp({});
    const client = new OriginsClient(http);
    assert.deepEqual(await client.list("p1"), []);
  });

  it("claim POSTs the domain to /origins/claim", async () => {
    const { http, calls } = makeHttp({
      domain: "app.acme.com",
      dns_record_name: "_realmid-verification.app.acme.com",
      dns_record_value: "tok",
      status: "pending",
    });
    const client = new OriginsClient(http);
    const resp = await client.claim("p1", { domain: "app.acme.com" });
    assert.equal(resp.dns_record_value, "tok");
    assert.equal(calls[0]!.opts.method, "POST");
    assert.equal(calls[0]!.opts.path, "/platforms/p1/origins/claim");
    assert.deepEqual(calls[0]!.opts.body, { domain: "app.acme.com" });
  });

  it("verify POSTs the domain to /origins/verify", async () => {
    const { http, calls } = makeHttp({ status: "verified" });
    const client = new OriginsClient(http);
    const resp = await client.verify("p1", { domain: "app.acme.com" });
    assert.equal(resp.status, "verified");
    assert.equal(calls[0]!.opts.path, "/platforms/p1/origins/verify");
  });

  it("bind POSTs the domain to /origins (base path)", async () => {
    const { http, calls } = makeHttp({
      id: "o2",
      domain: "app.acme.com",
      entity_type: "realm",
      entity_id: "p1",
      verification_id: "v1",
    });
    const client = new OriginsClient(http);
    const resp = await client.bind("p1", { domain: "app.acme.com" });
    assert.equal(resp.id, "o2");
    assert.equal(calls[0]!.opts.method, "POST");
    assert.equal(calls[0]!.opts.path, "/platforms/p1/origins");
  });

  it("remove DELETEs /origins/{originId} and encodes ids", async () => {
    const { http, calls } = makeHttp({ status: "ok" });
    const client = new OriginsClient(http);
    await client.remove("p 1", "o/2");
    assert.equal(calls[0]!.opts.method, "DELETE");
    assert.equal(calls[0]!.opts.path, "/platforms/p%201/origins/o%2F2");
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { realmFetchAsHttpClient } from "./transport.js";
import { RealmError } from "@realm-id/sdk";

interface CapturedCall {
  url: string;
  init: RequestInit & { anonymous?: boolean };
}

function makeRealm(handler: (call: CapturedCall) => Response | Promise<Response>) {
  const calls: CapturedCall[] = [];
  const realm = {
    async fetch(url: string | URL | Request, init: RequestInit & { anonymous?: boolean } = {}) {
      const call: CapturedCall = { url: String(url), init };
      calls.push(call);
      return handler(call);
    },
  };
  // The shim only consumes `realm.fetch`. Cast for typing.
  return { realm: realm as unknown as import("@realm-id/web").Realm, calls };
}

describe("realmFetchAsHttpClient", () => {
  it("passthrough request prefixes /api", async () => {
    const { realm, calls } = makeRealm(() =>
      new Response(JSON.stringify({ data: { items: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const http = realmFetchAsHttpClient(realm, { baseUrl: "https://api.partner.com" });
    await http.request({ method: "GET", path: "/tenants" });
    assert.equal(calls[0]!.url, "https://api.partner.com/api/tenants");
  });

  it("BFF-direct (/home) bypasses /api prefix", async () => {
    const { realm, calls } = makeRealm(() =>
      new Response(JSON.stringify({ data: { mode: "ops", platforms: {} } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const http = realmFetchAsHttpClient(realm, { baseUrl: "https://api.partner.com" });
    await http.request({ method: "GET", path: "/home", query: { owner: "me" } });
    assert.equal(calls[0]!.url, "https://api.partner.com/home?owner=me");
  });

  it("BFF-direct (/tenants/{id}/full) bypasses /api prefix", async () => {
    const { realm, calls } = makeRealm(() =>
      new Response(JSON.stringify({ data: { tenant: {}, events: {} } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const http = realmFetchAsHttpClient(realm, { baseUrl: "https://api.partner.com" });
    await http.request({ method: "GET", path: "/tenants/abc/full" });
    assert.equal(calls[0]!.url, "https://api.partner.com/tenants/abc/full");
  });

  it("/admin/* is NOT BFF-direct — routes through /api passthrough to the issuer", async () => {
    const { realm, calls } = makeRealm(() =>
      new Response(JSON.stringify({ data: { platforms: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const http = realmFetchAsHttpClient(realm, { baseUrl: "https://api.partner.com" });
    await http.request({ method: "POST", path: "/admin/platforms/p1/signing-keys/rotate" });
    assert.equal(calls[0]!.url, "https://api.partner.com/api/admin/platforms/p1/signing-keys/rotate");
  });

  it("GET /identity-providers (no via header) is BFF-direct — the public lookup", async () => {
    const { realm, calls } = makeRealm(() =>
      new Response(JSON.stringify({ data: { providers: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const http = realmFetchAsHttpClient(realm, { baseUrl: "https://api.partner.com" });
    await http.request({ method: "GET", path: "/identity-providers", query: { platform: "web" } });
    assert.equal(calls[0]!.url, "https://api.partner.com/identity-providers?platform=web");
  });

  it("x-realmid-via:api forces /identity-providers through /api passthrough (admin CRUD) and strips the header", async () => {
    const { realm, calls } = makeRealm(() =>
      new Response(JSON.stringify({ data: { items: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const http = realmFetchAsHttpClient(realm, { baseUrl: "https://api.partner.com" });
    await http.request({
      method: "GET",
      path: "/identity-providers",
      query: { platform_id: "plt_1" },
      headers: { "x-realmid-via": "api" },
    });
    assert.equal(calls[0]!.url, "https://api.partner.com/api/identity-providers?platform_id=plt_1");
    // The routing header must never reach the wire.
    const sent = (calls[0]!.init.headers ?? {}) as Record<string, string>;
    assert.equal(sent["x-realmid-via"], undefined);
  });

  it("/auth/sessions is NOT BFF-direct — routes through /api to the issuer's authed surface", async () => {
    const { realm, calls } = makeRealm(() =>
      new Response(JSON.stringify({ data: { items: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const http = realmFetchAsHttpClient(realm, { baseUrl: "https://api.partner.com" });
    await http.request({ method: "GET", path: "/auth/sessions" });
    assert.equal(calls[0]!.url, "https://api.partner.com/api/auth/sessions");
  });

  it("BFF-direct (/sessions) — the pre-login revocation-token flow — bypasses /api", async () => {
    const { realm, calls } = makeRealm(() =>
      new Response(JSON.stringify({ data: { items: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const http = realmFetchAsHttpClient(realm, { baseUrl: "https://api.partner.com" });
    await http.request({ method: "GET", path: "/sessions" });
    assert.equal(calls[0]!.url, "https://api.partner.com/sessions");
  });

  it("unwraps a single { data: T } success envelope", async () => {
    const { realm } = makeRealm(() =>
      new Response(JSON.stringify({ data: { id: "t_1", name: "x" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const http = realmFetchAsHttpClient(realm, { baseUrl: "https://api.partner.com" });
    const got = await http.request<{ id: string; name: string }>({ method: "GET", path: "/tenants/t_1" });
    assert.deepEqual(got, { id: "t_1", name: "x" });
  });

  it("returns body verbatim when no data envelope is present", async () => {
    const { realm } = makeRealm(() =>
      new Response(JSON.stringify({ id: "t_1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const http = realmFetchAsHttpClient(realm, { baseUrl: "https://api.partner.com" });
    const got = await http.request<{ id: string }>({ method: "GET", path: "/tenants/t_1" });
    assert.deepEqual(got, { id: "t_1" });
  });

  it("204 returns undefined", async () => {
    const { realm } = makeRealm(() => new Response(null, { status: 204 }));
    const http = realmFetchAsHttpClient(realm, { baseUrl: "https://api.partner.com" });
    const got = await http.request({ method: "DELETE", path: "/auth/sessions/abc" });
    assert.equal(got, undefined);
  });

  it("nested error envelope throws RealmError with mapped code", async () => {
    const { realm } = makeRealm(() =>
      new Response(JSON.stringify({ error: { code: "forbidden", message: "nope" } }), {
        status: 403,
        headers: { "content-type": "application/json" },
      }),
    );
    const http = realmFetchAsHttpClient(realm, { baseUrl: "https://api.partner.com" });
    await assert.rejects(
      http.request({ method: "GET", path: "/admin/platforms" }),
      (err: unknown) => {
        assert.ok(err instanceof RealmError);
        assert.equal((err as RealmError).code, "forbidden");
        assert.equal((err as RealmError).message, "nope");
        assert.equal((err as RealmError).httpStatus, 403);
        return true;
      },
    );
  });

  it("flat error envelope { error: 'msg' } throws RealmError with status-mapped code", async () => {
    const { realm } = makeRealm(() =>
      new Response(JSON.stringify({ error: "not found here" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      }),
    );
    const http = realmFetchAsHttpClient(realm, { baseUrl: "https://api.partner.com" });
    await assert.rejects(
      http.request({ method: "GET", path: "/tenants/none" }),
      (err: unknown) => {
        assert.ok(err instanceof RealmError);
        assert.equal((err as RealmError).code, "not_found");
        assert.equal((err as RealmError).message, "not found here");
        return true;
      },
    );
  });

  it("explicit bearer sets Authorization and anonymous=true", async () => {
    const { realm, calls } = makeRealm(() =>
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const http = realmFetchAsHttpClient(realm, { baseUrl: "https://api.partner.com" });
    await http.request({ method: "GET", path: "/sessions", bearer: "rt_one_shot" });
    const init = calls[0]!.init;
    assert.equal(init.anonymous, true);
    const h = new Headers(init.headers);
    assert.equal(h.get("authorization"), "Bearer rt_one_shot");
  });

  it("skipPlatformToken=true also forces anonymous", async () => {
    const { realm, calls } = makeRealm(() =>
      new Response(JSON.stringify({ data: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const http = realmFetchAsHttpClient(realm, { baseUrl: "https://api.partner.com" });
    await http.request({ method: "GET", path: "/identity-providers", skipPlatformToken: true });
    assert.equal(calls[0]!.init.anonymous, true);
  });

  it("query params skip undefined values", async () => {
    const { realm, calls } = makeRealm(() =>
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const http = realmFetchAsHttpClient(realm, { baseUrl: "https://api.partner.com" });
    await http.request({
      method: "GET",
      path: "/tenants",
      query: { cursor: "abc", limit: undefined, q: "" },
    });
    assert.equal(calls[0]!.url, "https://api.partner.com/api/tenants?cursor=abc");
  });

  it("custom apiPrefix is honored for passthrough", async () => {
    const { realm, calls } = makeRealm(() =>
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const http = realmFetchAsHttpClient(realm, {
      baseUrl: "https://api.partner.com",
      apiPrefix: "/v1",
    });
    await http.request({ method: "GET", path: "/tenants" });
    assert.equal(calls[0]!.url, "https://api.partner.com/v1/tenants");
  });
});

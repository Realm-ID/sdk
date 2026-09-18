import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { realmFetchAsHttpClient } from "./transport.js";
import { RealmError, ERROR_CODES } from "@realm-id/sdk";

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

  it("re-throws a typed realm error from realm.fetch unchanged (not relabeled as network)", async () => {
    // realm.fetch detects "no current tenant" client-side and throws a typed
    // error before any request goes out. Crucially it is `@realm-id/web`'s
    // RealmError — a DIFFERENT class from this package's `@realm-id/sdk`
    // RealmError — so the transport must recognise it by its `code` property,
    // not `instanceof`. Simulate that cross-class shape with a plain Error
    // carrying a string `code`. The transport must surface it verbatim so
    // callers can branch on `unauthorized` and route to sign-in, rather than
    // see a misleading `network error calling GET /me: ...`.
    const webRealmError = Object.assign(new Error("no current tenant"), { code: "unauthorized" });
    const { realm } = makeRealm(() => {
      throw webRealmError;
    });
    const http = realmFetchAsHttpClient(realm, { baseUrl: "https://api.partner.com" });
    await assert.rejects(
      http.request({ method: "GET", path: "/me" }),
      (err: unknown) => {
        assert.equal(err, webRealmError); // same object, untouched
        assert.equal((err as { code?: string }).code, "unauthorized");
        assert.equal((err as Error).message, "no current tenant");
        return true;
      },
    );
  });

  it("wraps a genuine fetch failure (non-RealmError) as code:network", async () => {
    const { realm } = makeRealm(() => {
      throw new TypeError("Failed to fetch");
    });
    const http = realmFetchAsHttpClient(realm, { baseUrl: "https://api.partner.com" });
    await assert.rejects(
      http.request({ method: "GET", path: "/me" }),
      (err: unknown) => {
        assert.ok(err instanceof RealmError);
        assert.equal((err as RealmError).code, "network");
        assert.match((err as RealmError).message, /network error calling GET \/me: Failed to fetch/);
        return true;
      },
    );
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

/**
 * A `content-type` on a request with no body describes nothing — and it is not
 * free: it widens the CORS preflight's `access-control-request-headers`, so a
 * GET sent from here cannot share a preflight cache entry with the same GET
 * sent by `@realm-id/web` (whose own transport already omits it). That is one
 * of the two reasons a console page load paid for `/me` twice.
 */
describe("content-type is sent only with a body", () => {
  it("a GET sends no content-type", async () => {
    const { realm, calls } = makeRealm(() =>
      new Response(JSON.stringify({ data: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const http = realmFetchAsHttpClient(realm, { baseUrl: "https://api.partner.com" });
    await http.request({ method: "GET", path: "/me" });

    const headers = calls[0]!.init.headers as Record<string, string>;
    assert.equal(headers["content-type"], undefined);
    assert.equal(calls[0]!.init.body, undefined);
  });

  it("a POST carrying a body still sends content-type", async () => {
    const { realm, calls } = makeRealm(() =>
      new Response(JSON.stringify({ data: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const http = realmFetchAsHttpClient(realm, { baseUrl: "https://api.partner.com" });
    await http.request({ method: "POST", path: "/tenants", body: { name: "Acme" } });

    const headers = calls[0]!.init.headers as Record<string, string>;
    assert.equal(headers["content-type"], "application/json");
    assert.equal(calls[0]!.init.body, JSON.stringify({ name: "Acme" }));
  });

  it("a bodyless POST sends no content-type either — the guard is the BODY, not the method", async () => {
    const { realm, calls } = makeRealm(() =>
      new Response(JSON.stringify({ data: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const http = realmFetchAsHttpClient(realm, { baseUrl: "https://api.partner.com" });
    await http.request({ method: "POST", path: "/sessions/revoke-all" });

    const headers = calls[0]!.init.headers as Record<string, string>;
    assert.equal(headers["content-type"], undefined);
  });
});

// ── error-code drift ─────────────────────────────────────────────────────────
//
// The gate this replaces was a hand-written 33-entry array against a 76-entry
// taxonomy. Nothing failed: `mapErrorResponse` fell back to `statusToCode`, so
// 43 codes arrived as a generic `conflict`/`not_found`/`server_error` and the
// partner branch that the SDK documents never fired. The list had grown STALER
// while it sat filed (27 missing → 43).
//
// The assertion is the EFFECT, not the membership: a list test is satisfied by
// a list nothing reads. Every code is driven through the real transport on
// status **418**, which maps to `server_error` — so `error.code === code` can
// only be true because the code was recognised, never because the status
// fallback happened to agree.
describe("transport error-code coverage (derived from @realm-id/sdk)", () => {
  it("is not vacuous — the taxonomy source is present and plausibly sized", () => {
    // An empty or unreadable ERROR_CODES would make every assertion below pass
    // over zero iterations. This is the anti-vacuity floor: the taxonomy has
    // ~76 entries and only ever grows.
    assert.ok(Array.isArray(ERROR_CODES), "ERROR_CODES is not an array");
    assert.ok(
      ERROR_CODES.length >= 60,
      `ERROR_CODES holds ${ERROR_CODES.length} codes (expected >= 60) — the ` +
        "source set is truncated or unreadable, so this suite proves nothing",
    );
  });

  it("surfaces every code in the taxonomy instead of the status fallback", async () => {
    const missed: string[] = [];
    let checked = 0;

    for (const code of ERROR_CODES) {
      if (code === "server_error") continue; // indistinguishable from the 418 fallback
      const { realm } = makeRealm(() =>
        new Response(JSON.stringify({ error: { code, message: "x" } }), {
          status: 418,
          headers: { "content-type": "application/json" },
        }),
      );
      const http = realmFetchAsHttpClient(realm, { baseUrl: "https://api.partner.com" });
      try {
        await http.request({ method: "GET", path: "/tenants" });
        missed.push(`${code} (no error thrown)`);
        continue;
      } catch (e) {
        assert.ok(e instanceof RealmError, `${code} did not throw a RealmError`);
        if (e.code !== code) missed.push(`${code} → ${e.code}`);
      }
      checked += 1;
    }

    assert.equal(
      checked,
      ERROR_CODES.length - 1,
      "the loop did not visit every code — it exited early",
    );
    assert.deepEqual(
      missed,
      [],
      "these codes collapsed into the HTTP-status fallback: " + missed.join(", "),
    );
  });

  it("still stashes an UNREGISTERED server code rather than claiming it", async () => {
    // The control. Without it the assertion above is satisfied by an
    // `isErrorCode` that returns true for everything, which would make the
    // taxonomy it checks irrelevant.
    const { realm } = makeRealm(() =>
      new Response(JSON.stringify({ error: { code: "definitely_not_registered", message: "x" } }), {
        status: 418,
        headers: { "content-type": "application/json" },
      }),
    );
    const http = realmFetchAsHttpClient(realm, { baseUrl: "https://api.partner.com" });
    await assert.rejects(
      () => http.request({ method: "GET", path: "/tenants" }),
      (e: unknown) => {
        assert.ok(e instanceof RealmError);
        assert.equal(e.code, "server_error");
        assert.equal(e.details?.server_code, "definitely_not_registered");
        return true;
      },
    );
  });
});

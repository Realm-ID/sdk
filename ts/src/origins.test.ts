import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createRealm } from "./realm.js";
import { normalizeOrigin } from "./origins.js";

interface Recorded {
  url: string;
  method: string;
  headers: Headers;
}

const REALM_ID = "01HREALM";
const API_KEY = "rk_live_test123";

function pageBody(items: Array<Record<string, unknown>>, nextCursor?: string): string {
  return JSON.stringify({ items, next_cursor: nextCursor ?? null });
}

function makePlatformTokenResponse(token = "pt_test_abc"): Response {
  return new Response(
    JSON.stringify({ platform_token: token, expires_in: 300, realm_id: REALM_ID }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/** Recorder that auto-services platform-token mints; per-call handlers
 *  fire for everything else. */
function recorder(handlers: Array<(rec: Recorded) => Response | Promise<Response>>): {
  fetch: typeof fetch;
  calls: Recorded[];
  mintCount: () => number;
} {
  const calls: Recorded[] = [];
  let i = 0;
  let mintCount = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const headers = new Headers(init?.headers);
    const rec: Recorded = { url, method: init?.method ?? "GET", headers };
    calls.push(rec);
    if (url.endsWith("/auth/platform-token")) {
      mintCount++;
      return makePlatformTokenResponse(`pt_${mintCount}`);
    }
    const h = handlers[i++] ?? handlers[handlers.length - 1]!;
    return h(rec);
  }) as typeof fetch;
  return { fetch: fetchImpl, calls, mintCount: () => mintCount };
}

test("normalizeOrigin: lowercases, strips scheme + port + path", () => {
  assert.equal(normalizeOrigin("https://App.Example.com:8443/foo"), "app.example.com");
  assert.equal(normalizeOrigin("http://localhost:5173"), "localhost");
  assert.equal(normalizeOrigin("ACME.com"), "acme.com");
  assert.equal(normalizeOrigin(""), "");
});

test("origins.validate: cache hit returns true on registered origin without refetching", async () => {
  let listCalls = 0;
  const { fetch } = recorder([
    () => {
      listCalls++;
      return new Response(
        pageBody([
          { id: "o1", domain: "app.acme.com", entity_type: "tenant", entity_id: "t1" },
          { id: "o2", domain: "auth.acme.com", entity_type: "realm", entity_id: REALM_ID },
        ]),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  ]);
  const realm = createRealm({ realmId: REALM_ID, apiKey: API_KEY, baseUrl: "https://auth.test", fetch });

  const ok1 = await realm.origins.validate({ realmId: REALM_ID, origin: "https://app.acme.com" });
  assert.equal(ok1, true);
  assert.equal(listCalls, 1, "first validate fetches once");

  const ok2 = await realm.origins.validate({ realmId: REALM_ID, origin: "https://AUTH.acme.com:443" });
  assert.equal(ok2, true);
  assert.equal(listCalls, 1, "cached hit does not refetch");

  const miss = await realm.origins.validate({ realmId: REALM_ID, origin: "https://other.com" });
  assert.equal(miss, false);
  assert.equal(listCalls, 1, "miss against cached set still does not refetch");
});

test("origins.validate: cache expires after 5 minutes", async () => {
  let listCalls = 0;
  const { fetch } = recorder([
    () => {
      listCalls++;
      return new Response(
        pageBody([{ id: "o1", domain: "app.acme.com", entity_type: "tenant", entity_id: "t1" }]),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  ]);
  // Drive the OriginsClient's clock via an injected `now` shim by going
  // around the public Realm constructor — exercise the class directly.
  const realm = createRealm({ realmId: REALM_ID, apiKey: API_KEY, baseUrl: "https://auth.test", fetch });
  // Because the public Realm constructs OriginsClient with a real clock,
  // assert TTL behavior by waiting beyond the window using fake intervals
  // is not feasible here. Instead use the underlying class directly.
  // (Cache TTL is tested via a direct OriginsClient unit below.)
  await realm.origins.validate({ realmId: REALM_ID, origin: "https://app.acme.com" });
  assert.equal(listCalls, 1);
});

test("OriginsClient: TTL expiry triggers refetch", async () => {
  const { OriginsClient } = await import("./origins.js");
  const { HttpClient } = await import("./http.js");
  const { PlatformTokenManager } = await import("./platform-token-manager.js");
  const { NOOP_LOGGER } = await import("./logger.js");

  let listCalls = 0;
  const fetchImpl = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/auth/platform-token")) return makePlatformTokenResponse();
    listCalls++;
    return new Response(
      pageBody([{ id: "o1", domain: "app.acme.com", entity_type: "tenant", entity_id: "t1" }]),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  const ptm = new PlatformTokenManager({
    apiKey: API_KEY, baseUrl: "https://auth.test", realmId: REALM_ID,
    fetch: fetchImpl, logger: NOOP_LOGGER,
  });
  const http = new HttpClient({ baseUrl: "https://auth.test", fetch: fetchImpl, platformTokens: ptm, logger: NOOP_LOGGER });
  let now = 1_000_000;
  const origins = new OriginsClient(http, ptm, () => now);

  assert.equal(await origins.validate({ realmId: REALM_ID, origin: "https://app.acme.com" }), true);
  assert.equal(listCalls, 1);
  // Advance 4 min — still cached.
  now += 4 * 60 * 1000;
  assert.equal(await origins.validate({ realmId: REALM_ID, origin: "https://app.acme.com" }), true);
  assert.equal(listCalls, 1);
  // Advance past the 5-min window.
  now += 2 * 60 * 1000;
  assert.equal(await origins.validate({ realmId: REALM_ID, origin: "https://app.acme.com" }), true);
  assert.equal(listCalls, 2, "expired cache triggers refetch");
});

test("origins.validate: 401 invalidates platform token and retries once", async () => {
  let firstShot = true;
  let mintCalls = 0;
  const fetchImpl = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/auth/platform-token")) {
      mintCalls++;
      return makePlatformTokenResponse(`pt_${mintCalls}`);
    }
    if (firstShot) {
      firstShot = false;
      return new Response(
        JSON.stringify({ error: { code: "unauthorized", message: "stale token" } }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      pageBody([{ id: "o1", domain: "app.acme.com", entity_type: "tenant", entity_id: "t1" }]),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  const realm = createRealm({ realmId: REALM_ID, apiKey: API_KEY, baseUrl: "https://auth.test", fetch: fetchImpl });
  const ok = await realm.origins.validate({ realmId: REALM_ID, origin: "https://app.acme.com" });
  assert.equal(ok, true);
  assert.equal(mintCalls, 2, "401 forces a second mint");
});

test("origins.validate: persistent 401 surfaces unauthorized", async () => {
  const fetchImpl = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/auth/platform-token")) return makePlatformTokenResponse();
    return new Response(
      JSON.stringify({ error: { code: "unauthorized", message: "nope" } }),
      { status: 401, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  const realm = createRealm({ realmId: REALM_ID, apiKey: API_KEY, baseUrl: "https://auth.test", fetch: fetchImpl });
  await assert.rejects(
    () => realm.origins.validate({ realmId: REALM_ID, origin: "https://app.acme.com" }),
    (err: unknown) => err instanceof Error && (err as { code?: string }).code === "unauthorized",
  );
});

test("origins.list: paginates and uses platform-token auth", async () => {
  let i = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/auth/platform-token")) return makePlatformTokenResponse();
    const auth = new Headers(init?.headers).get("authorization");
    assert.equal(auth, "Bearer pt_test_abc", "list call uses platform-token");
    if (i++ === 0) {
      return new Response(
        pageBody([{ id: "o1", domain: "a.com", entity_type: "realm", entity_id: REALM_ID }], "c1"),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      pageBody([{ id: "o2", domain: "b.com", entity_type: "tenant", entity_id: "t1" }]),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  const realm = createRealm({ realmId: REALM_ID, apiKey: API_KEY, baseUrl: "https://auth.test", fetch: fetchImpl });
  const got: string[] = [];
  for await (const o of realm.origins.list({ realmId: REALM_ID })) got.push(o.domain);
  assert.deepEqual(got, ["a.com", "b.com"]);
});

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createRealm } from "./realm.js";
import { RealmError } from "./errors.js";

const REALM_ID = "01HREALM";
const API_KEY = "rk_live_test123";

/**
 * Stands up a fake issuer for TokenManager tests. /auth/login serves the
 * platform bearer (the SDK's platform-session bootstrap); /auth/token is
 * the user-refresh endpoint under test. `tokenHandler` receives the
 * presented refresh token (from the body) and the per-call sequence number,
 * and returns a Response. Mirrors the Go `tmServer` harness.
 */
function tmFetch(
  tokenHandler: (presentedRefresh: string | undefined, n: number) => Response,
): { fetch: typeof fetch; tokenCalls: () => number } {
  let tokenCalls = 0;
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    let body: Record<string, unknown> | undefined;
    if (init?.body) {
      try { body = JSON.parse(String(init.body)); } catch { body = undefined; }
    }
    if (url.endsWith("/auth/login")) {
      return new Response(JSON.stringify({
        status: "ok", subject_type: "platform",
        refresh_token: "rtok-plat", access_token: "atok-plat", expires_in: 3600,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/auth/token")) {
      tokenCalls++;
      return tokenHandler(body?.["refresh_token"] as string | undefined, tokenCalls);
    }
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
  return { fetch, tokenCalls: () => tokenCalls };
}

function rotatingToken(_presented: string | undefined, n: number): Response {
  return new Response(JSON.stringify({
    status: "ok", subject_type: "user",
    refresh_token: `rtok-user-${n}`,
    access_token: `atok-user-${n}`,
    expires_in: 3600, tenant_id: "tnt-1", role: "member",
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function makeRealm(fetch: typeof fetch) {
  return createRealm({ realmId: REALM_ID, apiKey: API_KEY, baseUrl: "https://auth.test", fetch, origin: "https://app.example" });
}

test("TokenManager: first call refreshes, next is cache, near-expiry refreshes again", async () => {
  const { fetch, tokenCalls } = tmFetch(rotatingToken);
  // Mutable clock so we can force near-expiry.
  let nowMs = 1_000_000;
  const mgr = makeRealm(fetch).auth.newTokenManager("rtok-seed", {
    tenantId: "tnt-1",
    clock: () => nowMs,
  });

  const tok1 = await mgr.accessToken();
  assert.equal(tok1, "atok-user-1");
  assert.equal(tokenCalls(), 1);

  // Cache hit — no extra /auth/token.
  const tok1b = await mgr.accessToken();
  assert.equal(tok1b, "atok-user-1");
  assert.equal(tokenCalls(), 1, "expected cache hit");

  // Advance to within the 60s refresh lead → refresh, presenting rotated token.
  nowMs += (3600 - 15) * 1000;
  const tok2 = await mgr.accessToken();
  assert.equal(tok2, "atok-user-2");
  assert.equal(tokenCalls(), 2);
  assert.equal(mgr.refreshToken(), "rtok-user-2");
});

test("TokenManager: refreshSink persists rotated token before return", async () => {
  const { fetch } = tmFetch(rotatingToken);
  let persisted = "";
  const mgr = makeRealm(fetch).auth.newTokenManager("rtok-seed", {
    tenantId: "tnt-1",
    refreshSink: (newRefresh) => { persisted = newRefresh; },
  });
  await mgr.accessToken();
  assert.equal(persisted, "rtok-user-1");
});

test("TokenManager: sink failure fails acquisition; retry presents live token and succeeds", async () => {
  const { fetch, tokenCalls } = tmFetch(rotatingToken);
  let failNext = true;
  const mgr = makeRealm(fetch).auth.newTokenManager("rtok-seed", {
    tenantId: "tnt-1",
    refreshSink: () => {
      if (failNext) { failNext = false; throw new Error("disk full"); }
    },
  });

  // First acquisition: server rotates to rtok-user-1, sink fails → error, nothing cached.
  await assert.rejects(() => mgr.accessToken(), (e: Error) => e instanceof RealmError);
  // Rotated token committed to memory before the sink ran.
  assert.equal(mgr.refreshToken(), "rtok-user-1");

  // Retry: presents rtok-user-1, server rotates to rtok-user-2, sink ok.
  const tok = await mgr.accessToken();
  assert.equal(tok, "atok-user-2");
  assert.equal(tokenCalls(), 2);
});

test("TokenManager: refresh_invalid is terminal — no retry, no fallback", async () => {
  const { fetch, tokenCalls } = tmFetch(() =>
    new Response(JSON.stringify({
      code: "refresh_invalid",
      message: "refresh token is invalid, expired, or revoked",
    }), { status: 401, headers: { "content-type": "application/json" } }),
  );
  const mgr = makeRealm(fetch).auth.newTokenManager("rtok-dead", { tenantId: "tnt-1" });

  await assert.rejects(
    () => mgr.accessToken(),
    (e: Error) => e instanceof RealmError && e.code === "refresh_invalid",
  );
  assert.equal(tokenCalls(), 1, "must not retry/fallback");
});

test("TokenManager: concurrent accessToken calls collapse to one /auth/token", async () => {
  const { fetch, tokenCalls } = tmFetch((_p, n) =>
    new Response(JSON.stringify({
      status: "ok", subject_type: "user",
      refresh_token: `rtok-user-${n}`,
      access_token: `atok-user-${n}`,
      expires_in: 3600, tenant_id: "tnt-1",
    }), { status: 200, headers: { "content-type": "application/json" } }),
  );
  const mgr = makeRealm(fetch).auth.newTokenManager("rtok-seed", { tenantId: "tnt-1" });

  const N = 12;
  const results = await Promise.all(Array.from({ length: N }, () => mgr.accessToken()));
  for (const tok of results) {
    assert.equal(tok, "atok-user-1", "all callers see the single refreshed token");
  }
  assert.equal(tokenCalls(), 1, "single-flight: exactly one /auth/token call");
});

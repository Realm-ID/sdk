import { test } from "node:test";
import { strict as assert } from "node:assert";
import { PlatformTokenManager } from "./platform-token-manager.js";
import { NOOP_LOGGER } from "./logger.js";
import { RealmError } from "./errors.js";

interface Call {
  url: string;
  method: string;
  authorization: string | null;
}

function mkFetch(handler: (call: Call) => Response | Promise<Response>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const headers = new Headers(init?.headers);
    const c: Call = { url, method: init?.method ?? "GET", authorization: headers.get("authorization") };
    calls.push(c);
    return handler(c);
  }) as typeof fetch;
  return { fetch, calls };
}

test("platform-token-manager: first call mints, subsequent calls within TTL reuse cache", async () => {
  let mints = 0;
  const { fetch, calls } = mkFetch(() => {
    mints++;
    return new Response(JSON.stringify({
      platform_token: `pt_${mints}`,
      expires_in: 300,
      realm_id: "r1",
    }), { status: 200, headers: { "content-type": "application/json" } });
  });
  let now = 1_700_000_000_000;
  const mgr = new PlatformTokenManager({
    apiKey: "rk_live_x", baseUrl: "https://auth.test", fetch, logger: NOOP_LOGGER, now: () => now,
  });

  const t1 = await mgr.getToken();
  const t2 = await mgr.getToken();
  now += 60_000; // +60s, well within 300s TTL
  const t3 = await mgr.getToken();
  assert.equal(t1, "pt_1");
  assert.equal(t2, "pt_1");
  assert.equal(t3, "pt_1");
  assert.equal(mints, 1);
  assert.equal(calls[0]!.method, "POST");
  assert.equal(calls[0]!.authorization, "Bearer rk_live_x");
});

test("platform-token-manager: re-mints when within 30s of expiry", async () => {
  let mints = 0;
  const { fetch } = mkFetch(() => {
    mints++;
    return new Response(JSON.stringify({
      platform_token: `pt_${mints}`,
      expires_in: 60,
    }), { status: 200, headers: { "content-type": "application/json" } });
  });
  let now = 1_700_000_000_000;
  const mgr = new PlatformTokenManager({
    apiKey: "rk_live_x", baseUrl: "https://auth.test", fetch, logger: NOOP_LOGGER, now: () => now,
  });

  const t1 = await mgr.getToken();
  assert.equal(t1, "pt_1");
  // +25s in: 35s remaining > 30s skew, should reuse.
  now += 25_000;
  const t2 = await mgr.getToken();
  assert.equal(t2, "pt_1");
  assert.equal(mints, 1);
  // +35s total: 25s remaining < 30s skew, should re-mint.
  now += 10_000;
  const t3 = await mgr.getToken();
  assert.equal(t3, "pt_2");
  assert.equal(mints, 2);
});

test("platform-token-manager: 401 from mint endpoint surfaces RealmError unauthorized", async () => {
  const { fetch } = mkFetch(() => new Response(JSON.stringify({
    error: { code: "unauthorized", message: "bad api key" },
  }), { status: 401, headers: { "content-type": "application/json" } }));
  const mgr = new PlatformTokenManager({
    apiKey: "rk_live_bad", baseUrl: "https://auth.test", fetch, logger: NOOP_LOGGER,
  });
  await assert.rejects(() => mgr.getToken(), (e: Error) => {
    return e instanceof RealmError && e.code === "unauthorized";
  });
});

test("platform-token-manager: malformed response surfaces server_error", async () => {
  const { fetch } = mkFetch(() => new Response(JSON.stringify({ wrong: "shape" }), {
    status: 200, headers: { "content-type": "application/json" },
  }));
  const mgr = new PlatformTokenManager({
    apiKey: "rk_live_x", baseUrl: "https://auth.test", fetch, logger: NOOP_LOGGER,
  });
  await assert.rejects(() => mgr.getToken(), (e: Error) => {
    return e instanceof RealmError && e.code === "server_error";
  });
});

test("platform-token-manager: never logs the raw api key (redaction smoke test)", async () => {
  const captured: Array<{ msg: string; meta?: Record<string, unknown> }> = [];
  const logger = {
    debug() {}, warn() {}, error() {},
    info(msg: string, meta?: Record<string, unknown>) { captured.push({ msg, meta }); },
  };
  const { fetch } = mkFetch(() => new Response(JSON.stringify({
    platform_token: "pt_xxxx",
    expires_in: 300,
  }), { status: 200, headers: { "content-type": "application/json" } }));
  const mgr = new PlatformTokenManager({
    apiKey: "rk_live_supersecret_full_value",
    baseUrl: "https://auth.test", fetch, logger,
  });
  await mgr.getToken();
  for (const ev of captured) {
    const blob = JSON.stringify(ev);
    assert.ok(!blob.includes("supersecret_full_value"), `raw API key leaked into log: ${blob}`);
    assert.ok(!blob.includes("pt_xxxx"), `raw platform token leaked into log: ${blob}`);
  }
  assert.ok(captured.length >= 1, "expected at least one info-level log event");
});

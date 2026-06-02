import { test } from "node:test";
import { strict as assert } from "node:assert";
import { PlatformTokenManager } from "./platform-token-manager.js";
import { staticApiKey } from "./credential.js";
import { NOOP_LOGGER } from "./logger.js";
import { RealmError } from "./errors.js";

interface Call {
  url: string;
  method: string;
  authorization: string | null;
  body?: unknown;
}

function mkFetch(handler: (call: Call) => Response | Promise<Response>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const headers = new Headers(init?.headers);
    let body: unknown = undefined;
    if (init?.body) {
      try { body = JSON.parse(String(init.body)); } catch { body = init.body; }
    }
    const c: Call = { url, method: init?.method ?? "GET", authorization: headers.get("authorization"), body };
    calls.push(c);
    return handler(c);
  }) as typeof fetch;
  return { fetch, calls };
}

function loginResponse(access: string, refresh = "rtok-platform", expires = 300): Response {
  return new Response(JSON.stringify({
    status: "ok",
    subject_type: "platform",
    refresh_token: refresh,
    access_token: access,
    expires_in: expires,
  }), { status: 200, headers: { "content-type": "application/json" } });
}

test("session: first call hits /auth/login, subsequent calls within TTL reuse cache", async () => {
  let logins = 0, refreshes = 0;
  const { fetch, calls } = mkFetch((c) => {
    if (c.url.endsWith("/auth/login")) { logins++; return loginResponse(`at_${logins}`); }
    if (c.url.endsWith("/auth/token")) { refreshes++; return loginResponse(`at_r_${refreshes}`); }
    return new Response("nope", { status: 404 });
  });
  let now = 1_700_000_000_000;
  const mgr = new PlatformTokenManager({
    credential: staticApiKey("rk_live_x"), baseUrl: "https://auth.test", fetch, logger: NOOP_LOGGER, now: () => now,
  });

  const t1 = await mgr.getToken();
  const t2 = await mgr.getToken();
  now += 60_000; // well within 300s TTL
  const t3 = await mgr.getToken();
  assert.equal(t1, "at_1");
  assert.equal(t2, "at_1");
  assert.equal(t3, "at_1");
  assert.equal(logins, 1);
  assert.equal(refreshes, 0);
  assert.equal(calls[0]!.method, "POST");
  assert.equal(calls[0]!.url.endsWith("/auth/login"), true);
  // raw api-key only travels in the body, never as a bearer
  assert.equal(calls[0]!.authorization, null);
  assert.equal((calls[0]!.body as { grant_type: string }).grant_type, "platform_api_key");
});

test("session: refreshes via /auth/token when within 30s of expiry", async () => {
  let logins = 0, refreshes = 0;
  const { fetch } = mkFetch((c) => {
    if (c.url.endsWith("/auth/login")) { logins++; return loginResponse(`at_${logins}`, "rtok-1", 60); }
    if (c.url.endsWith("/auth/token")) { refreshes++; return loginResponse(`at_r_${refreshes}`, "rtok-1", 60); }
    return new Response("nope", { status: 404 });
  });
  let now = 1_700_000_000_000;
  const mgr = new PlatformTokenManager({
    credential: staticApiKey("rk_live_x"), baseUrl: "https://auth.test", fetch, logger: NOOP_LOGGER, now: () => now,
  });

  const t1 = await mgr.getToken();
  assert.equal(t1, "at_1");
  now += 25_000; // 35s remaining > 30s skew → reuse
  const t2 = await mgr.getToken();
  assert.equal(t2, "at_1");
  assert.equal(refreshes, 0);
  now += 10_000; // 25s remaining < 30s skew → /auth/token
  const t3 = await mgr.getToken();
  assert.equal(t3, "at_r_1");
  assert.equal(logins, 1);
  assert.equal(refreshes, 1);
});

test("session: /auth/token 401 falls back to /auth/login", async () => {
  let logins = 0;
  const { fetch } = mkFetch((c) => {
    if (c.url.endsWith("/auth/login")) { logins++; return loginResponse(`at_${logins}`, "rtok-1", 60); }
    if (c.url.endsWith("/auth/token")) {
      return new Response(JSON.stringify({ error: { code: "unauthorized", message: "refresh revoked" } }),
        { status: 401, headers: { "content-type": "application/json" } });
    }
    return new Response("nope", { status: 404 });
  });
  let now = 1_700_000_000_000;
  const mgr = new PlatformTokenManager({
    credential: staticApiKey("rk_live_x"), baseUrl: "https://auth.test", fetch, logger: NOOP_LOGGER, now: () => now,
  });
  await mgr.getToken();
  now += 50_000; // force refresh window
  const t = await mgr.getToken();
  assert.equal(t, "at_2"); // re-logged in
  assert.equal(logins, 2);
});

test("session: 401 from /auth/login surfaces RealmError unauthorized", async () => {
  const { fetch } = mkFetch(() => new Response(JSON.stringify({
    error: { code: "unauthorized", message: "bad api key" },
  }), { status: 401, headers: { "content-type": "application/json" } }));
  const mgr = new PlatformTokenManager({
    credential: staticApiKey("rk_live_bad"), baseUrl: "https://auth.test", fetch, logger: NOOP_LOGGER,
  });
  await assert.rejects(() => mgr.getToken(), (e: Error) => {
    return e instanceof RealmError && e.code === "unauthorized";
  });
});

test("session: malformed response surfaces server_error", async () => {
  const { fetch } = mkFetch(() => new Response(JSON.stringify({ wrong: "shape" }), {
    status: 200, headers: { "content-type": "application/json" },
  }));
  const mgr = new PlatformTokenManager({
    credential: staticApiKey("rk_live_x"), baseUrl: "https://auth.test", fetch, logger: NOOP_LOGGER,
  });
  await assert.rejects(() => mgr.getToken(), (e: Error) => {
    return e instanceof RealmError && e.code === "server_error";
  });
});

test("session: never logs the raw api key (redaction smoke test)", async () => {
  const captured: Array<{ msg: string; meta?: Record<string, unknown> }> = [];
  const logger = {
    debug() {}, warn() {}, error() {},
    info(msg: string, meta?: Record<string, unknown>) { captured.push({ msg, meta }); },
  };
  const { fetch } = mkFetch(() => loginResponse("at_xxxx"));
  const mgr = new PlatformTokenManager({
    credential: staticApiKey("rk_live_supersecret_full_value"),
    baseUrl: "https://auth.test", fetch, logger,
  });
  await mgr.getToken();
  for (const ev of captured) {
    const blob = JSON.stringify(ev);
    assert.ok(!blob.includes("supersecret_full_value"), `raw API key leaked into log: ${blob}`);
    assert.ok(!blob.includes("at_xxxx"), `raw access token leaked into log: ${blob}`);
  }
  assert.ok(captured.length >= 1, "expected at least one info-level log event");
});

test("session: token-exchange credential posts grant_type + subject_token (ADR-057)", async () => {
  const { fetch, calls } = mkFetch((c) => {
    if (c.url.endsWith("/auth/login")) return loginResponse("at_fed");
    return new Response("nope", { status: 404 });
  });
  const cred = {
    async fetch() {
      return {
        grantType: "urn:ietf:params:oauth:grant-type:token-exchange",
        subjectToken: "workload.jwt.tok",
      };
    },
  };
  const mgr = new PlatformTokenManager({
    credential: cred, baseUrl: "https://auth.test", fetch, logger: NOOP_LOGGER,
  });
  const t = await mgr.getToken();
  assert.equal(t, "at_fed");
  const body = calls[0]!.body as Record<string, string>;
  assert.equal(body.grant_type, "urn:ietf:params:oauth:grant-type:token-exchange");
  assert.equal(body.subject_token, "workload.jwt.tok");
  assert.equal(body.subject_token_type, "urn:ietf:params:oauth:token-type:jwt");
  assert.equal(body.api_key, undefined);
});

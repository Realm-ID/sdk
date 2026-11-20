// The issuer's Retry-After on a refusal the middleware answers is relayed to the browser.
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createRealm } from "./realm.js";
import { createMemorySessionStore } from "./session-store.js";
import { isPlatformMint } from "./auth-mint-helpers.test.js";

class Res {
  statusCode = 200;
  headers: Record<string, unknown> = {};
  chunks: string[] = [];
  headersSent = false;
  setHeader(n: string, v: unknown) { this.headers[n.toLowerCase()] = v; }
  getHeader(n: string) { return this.headers[n.toLowerCase()]; }
  end(c?: string) { if (c) this.chunks.push(c); this.headersSent = true; }
  writeHead(s: number) { this.statusCode = s; }
  get body() { return this.chunks.join(""); }
}

async function loginRefused(status: number, code: string, retryAfter?: string) {
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (isPlatformMint(url, init) && body.grant_type === "platform_api_key") {
      return new Response(JSON.stringify({ status: "ok", subject_type: "platform", refresh_token: "r", access_token: "pt", expires_in: 300 }),
        { status: 200, headers: { "content-type": "application/json" } });
    }
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (retryAfter) headers["retry-after"] = retryAfter;
    return new Response(JSON.stringify({ error: { code, message: "slow down" } }), { status, headers });
  }) as typeof fetch;
  const realm = createRealm({ sessionStore: createMemorySessionStore(), realmId: "r1", apiKey: "rk_live_x",
    baseUrl: "https://auth.test", origin: "https://app.test", fetch: fetchFn });
  const mw = realm.middleware();
  const res = new Res();
  await new Promise<void>((resolve) => {
    mw({ url: "/login", method: "POST", headers: { "content-type": "application/json" },
      body: { grant_type: "provider_token", method: "firebase", provider_token: "x" } } as never, res as never, () => resolve());
    setTimeout(resolve, 100);
  });
  return res;
}

test("middleware login: a 429 carrying Retry-After relays it to the browser", async () => {
  const res = await loginRefused(429, "sign_in_ip_rate_limited", "37");
  assert.equal(res.statusCode, 429);
  assert.equal(res.headers["retry-after"], "37");
});

test("middleware login: a 503 carrying Retry-After relays it too", async () => {
  const res = await loginRefused(503, "server_error", "9");
  assert.equal(res.statusCode, 503);
  assert.equal(res.headers["retry-after"], "9");
});

test("middleware login: a refusal shown under a different status keeps the issuer's Retry-After", async () => {
  const res = await loginRefused(403, "escort_suspended", "5");
  assert.equal(res.statusCode, 503);
  assert.equal(res.headers["retry-after"], "5");
});

test("middleware refresh: Retry-After rides the first answer and the stored outcome", async () => {
  // Only the first issuer answer carries the header, so a second answer that still has it came from storage.
  let tokenHits = 0;
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (isPlatformMint(url, init) && body.grant_type === "platform_api_key") {
      return new Response(JSON.stringify({ status: "ok", subject_type: "platform", refresh_token: "r", access_token: "pt", expires_in: 300 }),
        { status: 200, headers: { "content-type": "application/json" } });
    }
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (url.endsWith("/auth/token")) {
      tokenHits++;
      if (tokenHits === 1) headers["retry-after"] = "21";
    }
    return new Response(JSON.stringify({ error: { code: "server_error", message: "slow down" } }),
      { status: 429, headers });
  }) as typeof fetch;
  const realm = createRealm({ sessionStore: createMemorySessionStore(), realmId: "r1", apiKey: "rk_live_x",
    baseUrl: "https://auth.test", origin: "https://app.test", fetch: fetchFn });
  const mw = realm.middleware();
  for (let i = 0; i < 2; i++) {
    const res = new Res();
    await new Promise<void>((resolve) => {
      mw({ url: "/token", method: "POST", headers: { "content-type": "application/json", cookie: "realmid_refresh=rtok0" },
        body: { tenant_id: "t1" } } as never, res as never, () => resolve());
      setTimeout(resolve, 150);
    });
    assert.equal(res.statusCode, 429, `call ${i}`);
    assert.equal(res.headers["retry-after"], "21", `call ${i}`);
  }
  assert.equal(tokenHits, 1, "the second answer must come from the stored outcome");
});

test("middleware login: an issuer answer with no Retry-After produces none", async () => {
  const res = await loginRefused(429, "sign_in_ip_rate_limited");
  assert.equal(res.headers["retry-after"], undefined);
});

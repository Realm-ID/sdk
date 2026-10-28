// Parity with sdk/go relayStatus: user_suspended is relayed as the issuer's 403 and
// never ends the session; escort_suspended (403 upstream, the BFF's own escort
// account) is shown to the SPA as 503 so it reads a service problem.
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

async function loginRefused(code: string) {
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (isPlatformMint(url, init) && body.grant_type === "platform_api_key") {
      return new Response(JSON.stringify({ status: "ok", subject_type: "platform", refresh_token: "r", access_token: "pt", expires_in: 300 }),
        { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ error: { code, message: "refused" } }), { status: 403, headers: { "content-type": "application/json" } });
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

test("middleware login: user_suspended relays 403, sets no cookie", async () => {
  const res = await loginRefused("user_suspended");
  assert.equal(res.statusCode, 403);
  assert.equal(JSON.parse(res.body).error.code, "user_suspended");
  assert.equal(res.headers["set-cookie"], undefined);
});

test("middleware login: escort_suspended is relayed as 503", async () => {
  const res = await loginRefused("escort_suspended");
  assert.equal(res.statusCode, 503);
  assert.equal(JSON.parse(res.body).error.code, "escort_suspended");
});

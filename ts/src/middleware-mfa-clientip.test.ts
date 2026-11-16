import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createMemorySessionStore } from "./session-store.js";
import { createRealm } from "./realm.js";
import { isPlatformMint } from "./auth-mint-helpers.test.js";

// Issuer middleware.go (c-01/c-02) puts POST /auth/mfa/verify and /auth/mfa/recovery on the per-IP
// public-auth limiter, keyed on X-On-Behalf-Of-IP when a platform-bearer caller supplies it. SDK SPEC
// §10.1 steps 5 / 5a: the middleware forwards the end user's IP on both calls, and the direct
// auth.mfaVerify / auth.redeemRecoveryCode take `onBehalfOfIp` like sendLoginCode does.

class MockRes {
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

function rig() {
  const seen: Record<string, string | null> = {};
  const realm = createRealm({
    sessionStore: createMemorySessionStore(), realmId: "r1", apiKey: "rk_live_x",
    baseUrl: "https://auth.test", origin: "https://app.test",
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (isPlatformMint(url, init)) {
        return new Response(JSON.stringify({ status: "ok", subject_type: "platform", refresh_token: "rp", access_token: "pt_x", expires_in: 300 }),
          { status: 200, headers: { "content-type": "application/json" } });
      }
      seen[new URL(url).pathname] = new Headers(init?.headers).get("x-on-behalf-of-ip");
      return new Response(JSON.stringify({ access_token: "", refresh_token: "rt", expires_in: 900, user: { id: "u1" }, tenants: [] }),
        { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch,
  });
  return { seen, realm };
}

async function post(realm: ReturnType<typeof rig>["realm"], path: string, mw: Record<string, unknown>) {
  const res = new MockRes();
  await realm.middleware({ recoveryPath: "/mfa/recovery", tokenDelivery: "body", ...mw })({
    url: path, method: "POST", headers: { "x-real-ip": "198.51.100.9", "x-forwarded-for": "192.0.2.66" },
    socket: { remoteAddress: "203.0.113.5" }, body: { mfa_challenge_token: "c", code: "123456" },
  } as never, res as never, ((e?: unknown) => { throw new Error("fell through " + String(e)); }) as never);
  return res;
}

for (const [route, issuerPath] of [["/mfa/verify", "/auth/mfa/verify"], ["/mfa/recovery", "/auth/mfa/recovery"]] as const) {
  test(`middleware ${route}: forwards the socket address as X-On-Behalf-Of-IP, never X-Forwarded-For`, async () => {
    const { seen, realm } = rig();
    const res = await post(realm, route, {});
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(seen[issuerPath], "203.0.113.5");
  });
  test(`middleware ${route}: a clientIp hook wins`, async () => {
    const { seen, realm } = rig();
    const res = await post(realm, route, { clientIp: (r: { headers: Record<string, string> }) => r.headers["x-real-ip"] });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(seen[issuerPath], "198.51.100.9");
  });
}

test("direct auth.mfaVerify and auth.redeemRecoveryCode send onBehalfOfIp as X-On-Behalf-Of-IP", async () => {
  const { seen, realm } = rig();
  await realm.auth.mfaVerify({ challengeToken: "c", code: "1", onBehalfOfIp: "198.51.100.7" });
  await realm.auth.redeemRecoveryCode({ challengeToken: "c", code: "abcd-efgh", onBehalfOfIp: "198.51.100.8" });
  assert.equal(seen["/auth/mfa/verify"], "198.51.100.7");
  assert.equal(seen["/auth/mfa/recovery"], "198.51.100.8");
});

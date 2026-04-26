import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createRealm } from "./realm.js";
import { globMatch } from "./middleware.js";

class MockRes {
  statusCode = 200;
  headers: Record<string, string | string[] | number> = {};
  bodyChunks: string[] = [];
  headersSent = false;
  setHeader(name: string, value: string | string[] | number) {
    this.headers[name.toLowerCase()] = value;
  }
  getHeader(name: string) {
    return this.headers[name.toLowerCase()];
  }
  end(chunk?: string) {
    if (chunk) this.bodyChunks.push(chunk);
    this.headersSent = true;
  }
  writeHead(s: number) { this.statusCode = s; }
  get body() { return this.bodyChunks.join(""); }
  get setCookie(): string | string[] | undefined {
    const v = this.headers["set-cookie"];
    if (typeof v === "string" || Array.isArray(v)) return v;
    return undefined;
  }
}

function mkReq(opts: { url: string; method?: string; headers?: Record<string, string>; body?: unknown }) {
  return {
    url: opts.url,
    method: opts.method ?? "GET",
    headers: opts.headers ?? {},
    body: opts.body,
  };
}

/** Fetch that auto-services platform-token and forwards the rest to the handler. */
function autoFetch(handler: (url: string, init: RequestInit | undefined) => Promise<Response> | Response): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/auth/platform-token")) {
      return new Response(JSON.stringify({ platform_token: "pt_x", expires_in: 300 }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    return handler(url, init);
  }) as typeof fetch;
}

function makeRealm(handler: (url: string, init: RequestInit | undefined) => Promise<Response> | Response) {
  return createRealm({
    realmId: "r1",
    apiKey: "rk_live_x",
    baseUrl: "https://auth.test",
    origin: "https://app.test",
    fetch: autoFetch(handler),
  });
}

test("globMatch: handles single-segment and double-segment", () => {
  assert.equal(globMatch("/health", "/health"), true);
  assert.equal(globMatch("/public/*", "/public/foo"), true);
  assert.equal(globMatch("/public/*", "/public/foo/bar"), false);
  assert.equal(globMatch("/public/**", "/public/foo/bar"), true);
  assert.equal(globMatch("/webhooks/*", "/api/x"), false);
});

test("middleware: exempt path passes through to next", async () => {
  let nextCalled = false;
  const realm = makeRealm(() => new Response("{}", { status: 200 }));
  const mw = realm.middleware({ exemptPaths: ["/health"] });
  const req = mkReq({ url: "/health" });
  const res = new MockRes();
  await new Promise<void>((resolve, reject) => {
    mw(req, res as unknown as never, (err?: unknown) => {
      if (err) return reject(err);
      nextCalled = true;
      resolve();
    });
  });
  assert.equal(nextCalled, true);
  assert.equal(res.headersSent, false);
});

test("middleware: login route handles request and sets cookie", async () => {
  const realm = makeRealm((url) => {
    assert.match(url, /\/auth\/login$/);
    return new Response(JSON.stringify({
      access_token: "at",
      refresh_token: "rt-cookie",
      expires_in: 900,
      user: { id: "u1" },
      tenants: [{ id: "t1", role: "owner" }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  });
  const mw = realm.middleware();
  const req = mkReq({
    url: "/login",
    method: "POST",
    headers: { "content-type": "application/json" },
    body: { method: "firebase", provider_token: "id_x" },
  });
  const res = new MockRes();
  let nextErr: unknown;
  await new Promise<void>((resolve) => {
    mw(req, res as unknown as never, (e?: unknown) => { nextErr = e; resolve(); });
    setTimeout(() => resolve(), 50);
  });
  assert.equal(nextErr, undefined);
  assert.equal(res.statusCode, 200);
  const parsed = JSON.parse(res.body);
  assert.equal(parsed.access_token, "at");
  assert.equal(parsed.refresh_token, undefined, "cookie mode must not echo refresh_token in body");
  const cookie = res.setCookie;
  assert.ok(cookie, "expected set-cookie");
  const cookieStr = Array.isArray(cookie) ? cookie.join(";") : String(cookie);
  assert.match(cookieStr, /realmid_refresh=rt-cookie/);
  assert.match(cookieStr, /HttpOnly/);
  assert.match(cookieStr, /SameSite=Lax/);
});

test("middleware: tokenDelivery=body returns refresh_token in JSON, no cookie", async () => {
  const realm = makeRealm(() => new Response(JSON.stringify({
    access_token: "at",
    refresh_token: "rt-body",
    expires_in: 900,
    user: { id: "u1" },
    tenants: [],
  }), { status: 200, headers: { "content-type": "application/json" } }));
  const mw = realm.middleware({ tokenDelivery: "body" });
  const req = mkReq({
    url: "/login", method: "POST",
    headers: { "content-type": "application/json" },
    body: { method: "firebase", provider_token: "id_x" },
  });
  const res = new MockRes();
  await new Promise<void>((resolve) => {
    mw(req, res as unknown as never, () => resolve());
    setTimeout(resolve, 50);
  });
  assert.equal(res.statusCode, 200);
  const parsed = JSON.parse(res.body);
  assert.equal(parsed.access_token, "at");
  assert.equal(parsed.refresh_token, "rt-body");
  assert.equal(res.setCookie, undefined, "body mode must not set a refresh cookie");
});

test("middleware: unauthenticated request gets 401 envelope", async () => {
  const realm = makeRealm(() => new Response("{}", { status: 200 }));
  const mw = realm.middleware();
  const req = mkReq({ url: "/me" });
  const res = new MockRes();
  await new Promise<void>((resolve) => {
    mw(req, res as unknown as never, () => resolve());
    setTimeout(resolve, 50);
  });
  assert.equal(res.statusCode, 401);
  const parsed = JSON.parse(res.body);
  assert.equal(parsed.error.code, "unauthorized");
});

// ---- Helpers for signed-token tests ----

async function mintSignedToken(opts: {
  realmId: string; baseUrl: string; aud: string; extraClaims?: Record<string, unknown>;
}): Promise<{ token: string; publicJwk: object }> {
  const kp = await globalThis.crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true, ["sign", "verify"],
  );
  const jwk = await globalThis.crypto.subtle.exportKey("jwk", kp.publicKey);
  const publicJwk = { kty: jwk.kty!, n: jwk.n!, e: jwk.e!, kid: "k1", alg: "RS256", use: "sig" };
  const enc = (o: unknown) => {
    const bytes = new TextEncoder().encode(JSON.stringify(o));
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  };
  const header = enc({ alg: "RS256", typ: "JWT", kid: "k1" });
  const now = Math.floor(Date.now() / 1000);
  const payload = enc({
    iss: `${opts.baseUrl}/${opts.realmId}`,
    sub: "u1", aud: opts.aud, exp: now + 900, iat: now,
    tenant_id: "t1", role: "owner",
    ...opts.extraClaims,
  });
  const sig = await globalThis.crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" }, kp.privateKey, new TextEncoder().encode(`${header}.${payload}`),
  );
  let bin = "";
  for (const b of new Uint8Array(sig)) bin += String.fromCharCode(b);
  const sigStr = btoa(bin).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  return { token: `${header}.${payload}.${sigStr}`, publicJwk };
}

test("middleware: valid bearer attaches claims to req.realmid", async () => {
  const realmId = "r1";
  const baseUrl = "https://auth.test";
  const aud = "example.com";
  const { token, publicJwk } = await mintSignedToken({ realmId, baseUrl, aud });

  const fetch: typeof fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/auth/platform-token")) {
      return new Response(JSON.stringify({ platform_token: "pt_x", expires_in: 300 }), { status: 200 });
    }
    if (url.endsWith(`/${realmId}/.well-known/jwks.json`)) {
      return new Response(JSON.stringify({ keys: [publicJwk] }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  const realm = createRealm({ realmId, apiKey: "rk_live_x", baseUrl, fetch, audience: aud });
  const mw = realm.middleware();
  const req = mkReq({ url: "/me", headers: { authorization: `Bearer ${token}` } });
  const res = new MockRes();
  let nextCalled = false;
  await new Promise<void>((resolve) => {
    mw(req as never, res as unknown as never, () => { nextCalled = true; resolve(); });
    setTimeout(resolve, 200);
  });
  assert.equal(nextCalled, true, "expected next() to be called for valid token");
  const r = req as typeof req & { realmid?: { sub?: string; tenant_id?: string } };
  assert.equal(r.realmid?.sub, "u1");
  assert.equal(r.realmid?.tenant_id, "t1");
});

test("middleware: mfaProtectedPaths returns 412 mfa_required when token lacks MFA marker", async () => {
  const realmId = "r1";
  const baseUrl = "https://auth.test";
  const aud = "example.com";
  const { token, publicJwk } = await mintSignedToken({ realmId, baseUrl, aud });

  const fetch: typeof fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/auth/platform-token")) {
      return new Response(JSON.stringify({ platform_token: "pt_x", expires_in: 300 }), { status: 200 });
    }
    if (url.endsWith(`/${realmId}/.well-known/jwks.json`)) {
      return new Response(JSON.stringify({ keys: [publicJwk] }), { status: 200 });
    }
    if (url.endsWith("/auth/mfa/challenge")) {
      return new Response(JSON.stringify({ mfa_challenge_token: "ch_abc", methods: ["totp"] }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  const realm = createRealm({ realmId, apiKey: "rk_live_x", baseUrl, fetch, audience: aud });
  const mw = realm.middleware({ mfaProtectedPaths: ["/admin/*"] });
  const req = mkReq({ url: "/admin/me", headers: { authorization: `Bearer ${token}` } });
  const res = new MockRes();
  await new Promise<void>((resolve) => {
    mw(req as never, res as unknown as never, () => resolve());
    setTimeout(resolve, 200);
  });
  assert.equal(res.statusCode, 412);
  const parsed = JSON.parse(res.body);
  assert.equal(parsed.error.code, "mfa_required");
  assert.equal(parsed.mfa_challenge_token, "ch_abc");
});

test("middleware: mfaProtectedPaths lets through tokens carrying amr=mfa", async () => {
  const realmId = "r1";
  const baseUrl = "https://auth.test";
  const aud = "example.com";
  const { token, publicJwk } = await mintSignedToken({
    realmId, baseUrl, aud, extraClaims: { amr: ["pwd", "mfa"] },
  });

  const fetch: typeof fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/auth/platform-token")) {
      return new Response(JSON.stringify({ platform_token: "pt_x", expires_in: 300 }), { status: 200 });
    }
    if (url.endsWith(`/${realmId}/.well-known/jwks.json`)) {
      return new Response(JSON.stringify({ keys: [publicJwk] }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  const realm = createRealm({ realmId, apiKey: "rk_live_x", baseUrl, fetch, audience: aud });
  const mw = realm.middleware({ mfaProtectedPaths: ["/admin/*"] });
  const req = mkReq({ url: "/admin/me", headers: { authorization: `Bearer ${token}` } });
  const res = new MockRes();
  let nextCalled = false;
  await new Promise<void>((resolve) => {
    mw(req as never, res as unknown as never, () => { nextCalled = true; resolve(); });
    setTimeout(resolve, 200);
  });
  assert.equal(nextCalled, true);
  assert.equal(res.headersSent, false);
});

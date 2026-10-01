/**
 * Shared fixtures for the v0.63.0 tests (SPEC §5.1, §5.1.1, §6.7, §10.1).
 * Not a test file: the runner globs `*.test.ts`.
 */

export const BASE = "https://auth.test";
export const REALM = "r1";
export const AUD = "app.test";

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

export async function makeSigner(kid = "k1") {
  const kp = await globalThis.crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const jwk = await globalThis.crypto.subtle.exportKey("jwk", kp.publicKey);
  const publicJwk = { kty: jwk.kty!, n: jwk.n!, e: jwk.e!, kid, alg: "RS256", use: "sig" };
  /** `header` entries override the defaults; an `undefined` value deletes the member. */
  async function sign(claims: Record<string, unknown>, header: Record<string, unknown> = {}): Promise<string> {
    const h: Record<string, unknown> = { alg: "RS256", typ: "JWT", kid, ...header };
    for (const k of Object.keys(h)) if (h[k] === undefined) delete h[k];
    const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));
    const input = `${enc(h)}.${enc(claims)}`;
    const sig = await globalThis.crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, kp.privateKey, new TextEncoder().encode(input));
    return `${input}.${b64url(new Uint8Array(sig))}`;
  }
  return { publicJwk, sign };
}

/** An unsigned JWT-shaped string; the cache only peeks, never verifies. */
export function peekJwt(claims: Record<string, unknown>): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({ alg: "RS256", typ: "JWT" })}.${enc(claims)}.sig`;
}

export function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export function claimsFor(now: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: `${BASE}/${REALM}`, aud: AUD, sub: "u-acme", sid: "s1", jti: "s1",
    iat: now, exp: now + 900, tenant_id: "acme", ...over,
  };
}

export interface FakeIssuer {
  fetch: typeof fetch;
  calls: { url: string; body: Record<string, unknown> }[];
  count(pathSuffix: string): number;
  /** Set to change the discovery document served. */
  discovery: { body: unknown; status: number };
  /** Handler for POST /auth/token. */
  token: (body: Record<string, unknown>) => Response | Promise<Response>;
  logout: (body: Record<string, unknown>) => Response | Promise<Response>;
  mfaVerify: (body: Record<string, unknown>) => Response | Promise<Response>;
  login: (body: Record<string, unknown>) => Response | Promise<Response>;
}

/** A fake issuer: JWKS, discovery, platform bootstrap, plus overridable auth routes. */
export function fakeIssuer(publicJwk: object): FakeIssuer {
  const f: FakeIssuer = {
    calls: [],
    count: (s) => f.calls.filter((c) => c.url.endsWith(s)).length,
    discovery: { body: {}, status: 200 },
    token: () => jsonRes(500, {}),
    logout: () => jsonRes(200, { status: "ok" }),
    mfaVerify: () => jsonRes(500, {}),
    login: () => jsonRes(500, {}),
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      let body: Record<string, unknown> = {};
      if (init?.body) { try { body = JSON.parse(String(init.body)); } catch { /* not json */ } }
      f.calls.push({ url, body });
      if (url.endsWith("/.well-known/jwks.json")) return jsonRes(200, { keys: [publicJwk] });
      if (url.endsWith("/.well-known/openid-configuration")) return jsonRes(f.discovery.status, f.discovery.body);
      if (url.endsWith("/auth/login")) {
        if (body["grant_type"] === "platform_api_key") {
          return jsonRes(200, { status: "ok", subject_type: "platform", refresh_token: "rt-platform", access_token: "pt_x", expires_in: 300 });
        }
        return f.login(body);
      }
      if (url.endsWith("/auth/token")) return f.token(body);
      if (url.endsWith("/auth/logout")) return f.logout(body);
      if (url.endsWith("/auth/mfa/verify")) return f.mfaVerify(body);
      return jsonRes(404, { error: { code: "not_found", message: url } });
    }) as typeof fetch,
  };
  return f;
}

export class MockRes {
  statusCode = 200;
  headers: Record<string, string | string[] | number> = {};
  bodyChunks: string[] = [];
  headersSent = false;
  setHeader(n: string, v: string | string[] | number) { this.headers[n.toLowerCase()] = v; }
  getHeader(n: string) { return this.headers[n.toLowerCase()]; }
  end(c?: string) { if (c) this.bodyChunks.push(c); this.headersSent = true; }
  get body() { return this.bodyChunks.join(""); }
  get json(): Record<string, unknown> { return JSON.parse(this.body) as Record<string, unknown>; }
  get setCookie(): string[] {
    const v = this.headers["set-cookie"];
    return v === undefined ? [] : Array.isArray(v) ? (v as string[]) : [String(v)];
  }
}

/** Drive one request through a middleware; resolves with whether `next()` ran. */
export async function drive(
  mw: (req: never, res: never, next: (e?: unknown) => void) => unknown,
  req: { url: string; method?: string; headers?: Record<string, string>; body?: unknown },
): Promise<{ res: MockRes; nextCalled: boolean; reqObj: Record<string, unknown> }> {
  const res = new MockRes();
  const reqObj = { method: "GET", headers: {}, ...req } as Record<string, unknown>;
  let nextCalled = false;
  await new Promise<void>((resolve, reject) => {
    const next = (e?: unknown) => { if (e) reject(e); else { nextCalled = true; resolve(); } };
    Promise.resolve(mw(reqObj as never, res as never, next)).then(() => resolve(), reject);
  });
  return { res, nextCalled, reqObj };
}

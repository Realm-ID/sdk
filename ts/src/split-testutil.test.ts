// Shared fixtures for the split-signing / escort red tests (S2). Named *.test.ts so tsconfig excludes
// it from the build (it must not ship in dist) and the runner treats it as a file with no tests.
// A fake issuer here is a fetch function; no test in this family needs a live issuer (R71).

import { webcrypto } from "node:crypto";
import { createMemorySessionStore } from "./session-store.js";
import { createRealm, type Realm, type RealmConfig } from "./realm.js";
import { ShareEntry, type ShareBundle, type LoadedShares, type WritableShareSource } from "./split.js";

const subtle = webcrypto.subtle;

export const TEST_REALM = "r1";
export const TEST_AUD = "https://app.example.com";
export const BASE = "https://auth.test";

export const b64u = (b: Uint8Array): string => Buffer.from(b).toString("base64url");
export const fromB64u = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "base64url"));
export const toBig = (b: Uint8Array): bigint => (b.length === 0 ? 0n : BigInt("0x" + Buffer.from(b).toString("hex")));
export function fromBig(i: bigint, len = 0): Uint8Array {
  let h = i.toString(16);
  if (h.length % 2) h = "0" + h;
  const raw = new Uint8Array(Buffer.from(h, "hex"));
  if (len === 0) return raw;
  const out = new Uint8Array(len);
  out.set(raw, len - raw.length);
  return out;
}
export const b64big = (i: bigint): string => b64u(fromBig(i));
export const hexBytes = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "hex"));
export const toHex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

export function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let r = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return r;
}

const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? a : gcd(b, a % b));

const SHA256_PREFIX = Uint8Array.from([0x30, 0x31, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01, 0x05, 0x00, 0x04, 0x20]);

/** EMSA-PKCS1-v1_5 encoding of a SHA-256 digest into a 256-byte block, as an integer. */
export function emsaFromDigest(digest: Uint8Array): bigint {
  const t = new Uint8Array([...SHA256_PREFIX, ...digest]);
  const em = new Uint8Array(256);
  em[1] = 0x01;
  for (let i = 2; i < 256 - t.length - 1; i++) em[i] = 0xff;
  em.set(t, 256 - t.length);
  return toBig(em);
}

export const sha256 = async (s: string | Uint8Array): Promise<Uint8Array> =>
  new Uint8Array(await subtle.digest("SHA-256", typeof s === "string" ? new TextEncoder().encode(s) : s));

export interface Claims { [k: string]: unknown }

export class SplitKey {
  constructor(
    readonly kid: string,
    readonly n: bigint,
    readonly e: bigint,
    readonly dRI: bigint,
    readonly dP: bigint,
    readonly priv: CryptoKey,
  ) {}

  static async make(kid: string): Promise<SplitKey> {
    const kp = await subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true, ["sign", "verify"],
    );
    const j = await subtle.exportKey("jwk", kp.privateKey);
    const n = toBig(fromB64u(j.n!));
    const e = toBig(fromB64u(j.e!));
    const p1 = toBig(fromB64u(j.p!)) - 1n;
    const q1 = toBig(fromB64u(j.q!)) - 1n;
    const lam = (p1 * q1) / gcd(p1, q1);
    const d = toBig(fromB64u(j.d!)) % lam;
    const dRI = toBig(webcrypto.getRandomValues(new Uint8Array(256))) % lam;
    const dP = (((d - dRI) % lam) + lam) % lam;
    return new SplitKey(kid, n, e, dRI, dP, kp.privateKey);
  }

  entry(): ShareEntry {
    return new ShareEntry({ n: b64big(this.n), e: b64big(this.e), d_partner: b64big(this.dP) });
  }

  bundle(realm: string): ShareBundle {
    return { realm, shares: { [this.kid]: this.entry() } };
  }

  riPartial(digest: Uint8Array): Uint8Array {
    return fromBig(modPow(emsaFromDigest(digest), this.dRI, this.n), 256);
  }

  signingInput(claims: Claims, typ = "JWT"): { header: string; payload: string } {
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    return { header: enc({ alg: "RS256", typ, kid: this.kid }), payload: enc(claims) };
  }

  async fullJWT(claims: Claims): Promise<string> {
    const { header, payload } = this.signingInput(claims);
    const sig = new Uint8Array(await subtle.sign("RSASSA-PKCS1-v1_5", this.priv, new TextEncoder().encode(`${header}.${payload}`)));
    return `${header}.${payload}.${b64u(sig)}`;
  }

  async partialSigning(claims: Claims, typ = "JWT"): Promise<{ kid: string; header: string; payload: string; partialRi: string }> {
    const { header, payload } = this.signingInput(claims, typ);
    const digest = await sha256(`${header}.${payload}`);
    return { kid: this.kid, header, payload, partialRi: b64u(this.riPartial(digest)) };
  }

  /** The `/auth/token/partial` body for claims. */
  async partialAnswer(claims: Claims, refresh = ""): Promise<Record<string, unknown>> {
    const s = await this.partialSigning(claims);
    return {
      status: "ok", token_type: "partial", subject_type: "user", expires_in: 600,
      signing: { kid: s.kid, header: s.header, payload: s.payload, partial_ri: s.partialRi },
      ...(refresh ? { refresh_token: refresh } : {}),
    };
  }
}

/** Does `sig` verify under the public key (n, e) as RSASSA-PKCS1-v1_5/SHA-256 over `input`? Stock verifier. */
export async function verifyRS256(n: bigint, e: bigint, input: string, sig: Uint8Array): Promise<boolean> {
  const key = await subtle.importKey("jwk", { kty: "RSA", n: b64big(n), e: b64big(e), alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  return subtle.verify("RSASSA-PKCS1-v1_5", key, sig, new TextEncoder().encode(input));
}

/** Serialises a bundle the way an env/file source stores it (d_partner explicit: the class hides it). */
export function bundleJSON(b: ShareBundle): string {
  const shares: Record<string, unknown> = {};
  for (const [kid, s] of Object.entries(b.shares)) shares[kid] = { n: s.n, e: s.e, d_partner: s.d_partner };
  return JSON.stringify({ realm: b.realm, shares, ...(b.previous ? { previous: b.previous } : {}) });
}

/** In-memory writable source. */
export class MemShares implements WritableShareSource {
  v = 0;
  constructor(public b: ShareBundle) {}
  async load(): Promise<LoadedShares> { return { bundle: this.b, version: String(this.v) }; }
  async store(b: ShareBundle): Promise<string> { this.b = b; this.v++; return String(this.v); }
}

export interface Seen {
  method: string;
  path: string;
  auth: string;
  userToken: string;
  body: Record<string, any> | undefined;
}

type Handler = (req: Seen) => Response | Promise<Response>;

export function jsonReply(status: number, v: unknown): Response {
  return new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
}

/** Records every request. Platform mint is served ONLY at /auth/token (R49/R71); a platform_api_key
 *  sent to /auth/login is recorded and answered 400 login_grant_removed. */
export class FakeIssuer {
  seen: Seen[] = [];
  handlers = new Map<string, Handler>();
  override?: (req: Seen) => Response | undefined;
  /** Serve a platform_api_key at /auth/login (what the pre-R71 SDK does). Default true; see serve(). */
  legacyMint = true;

  fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const headers = new Headers(init?.headers);
    let body: Record<string, any> | undefined;
    if (typeof init?.body === "string" && init.body.length > 0) {
      try { body = JSON.parse(init.body); } catch { body = undefined; }
    }
    const req: Seen = {
      method: init?.method ?? "GET", path: url.pathname,
      auth: headers.get("authorization") ?? "", userToken: headers.get("x-user-token") ?? "", body,
    };
    this.seen.push(req);
    const o = this.override?.(req);
    if (o) return o;
    if (req.path === "/auth/token" && body?.grant_type === "platform_api_key") {
      return jsonReply(200, { status: "ok", subject_type: "platform", access_token: "ptok", expires_in: 300 });
    }
    if (req.path === "/auth/login" && body?.grant_type === "platform_api_key") {
      // The pre-R71 SDK mints here. Tolerated by default so each red test fails on ITS OWN assertion,
      // not on the shared bootstrap; login-token.test.ts asserts zero /auth/login platform mints.
      if (this.legacyMint) return jsonReply(200, { status: "ok", subject_type: "platform", access_token: "ptok", expires_in: 300 });
      return jsonReply(400, { error: { code: "login_grant_removed", message: "use /auth/token" } });
    }
    const h = this.handlers.get(req.path);
    if (h) return h(req);
    return jsonReply(404, { error: { code: "not_found", message: req.path } });
  }) as typeof fetch;

  on(path: string, h: Handler): void { this.handlers.set(path, h); }
  reqs(path: string): Seen[] { return this.seen.filter((s) => s.path === path); }
  paths(): string[] { return this.seen.map((s) => `${s.method} ${s.path}`); }
  get issuer(): string { return `${BASE}/${TEST_REALM}`; }

  cfg(mut?: (c: RealmConfig) => void): RealmConfig {
    const c: RealmConfig = {
      sessionStore: createMemorySessionStore(), realmId: TEST_REALM, apiKey: "rk", baseUrl: BASE,
      origin: "https://app.example.com", audience: TEST_AUD, fetch: this.fetch,
    };
    mut?.(c);
    return c;
  }

  realm(mut?: (c: RealmConfig) => void): Realm { return createRealm(this.cfg(mut)); }
}

export function userClaims(iss: string, nowSec = Math.floor(Date.now() / 1000)): Claims {
  return { iss, sub: "01HUSER", aud: TEST_AUD, iat: nowSec, exp: nowSec + 600 };
}

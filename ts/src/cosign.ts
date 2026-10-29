/**
 * Split-signing co-signing (SPEC §14.2, §14.3, §14.6). RealmID holds d_ri and the partner holds
 * d_partner of one RSA private exponent, d = d_ri + d_partner (mod lambda). RealmID answers with
 * s_ri = m^d_ri mod n over the EMSA-PKCS1-v1_5/SHA-256 encoding m of the exact `header.payload`
 * bytes; the partner multiplies by m^d_partner and gets an ordinary RS256 signature that any stock
 * verifier accepts. The SDK checks s^e == m before it releases anything (verify-before-release), so
 * a corrupt partial or a wrong share yields an error and no token.
 *
 * Server-only: reachable from `@realm-id/sdk/split`, never from the main entry (SPEC §14.9).
 * Same maths and refusals as `sdk/go/cosign.go`.
 */

import { createHash } from "node:crypto";
import { ctExp } from "./ctexp.js";
import { RealmError } from "./errors.js";
import type { ShareEntry } from "./share-source.js";

/** The `signing` object of a `/auth/token/partial` answer. `partialRi` is base64url. */
export interface PartialSigning {
  kid: string;
  header: string;
  payload: string;
  partialRi: string;
}

/** DER DigestInfo prefix for SHA-256 (RFC 8017 section 9.2 note 1). */
const SHA256_DIGEST_INFO = Uint8Array.from([
  0x30, 0x31, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01, 0x05, 0x00, 0x04, 0x20,
]);

const fail = (message: string): never => {
  throw new RealmError({ code: "bad_signature", message: `realmid: ${message}` });
};

const B64URL = /^[A-Za-z0-9_-]+$/;

/** Strict base64url (padding tolerated) to bytes; undefined when it is not base64url or is empty. */
export function b64urlBytes(s: string): Uint8Array | undefined {
  const t = s.replace(/=+$/, "");
  if (t.length === 0 || !B64URL.test(t)) return undefined;
  return new Uint8Array(Buffer.from(t, "base64url"));
}

export function b64urlEncode(b: Uint8Array): string {
  return Buffer.from(b).toString("base64url");
}

export function bytesToBig(b: Uint8Array): bigint {
  return b.length === 0 ? 0n : BigInt("0x" + Buffer.from(b).toString("hex"));
}

/** Big-endian bytes of i, left-padded to `len` (0 = minimal). */
export function bigToBytes(i: bigint, len = 0): Uint8Array {
  let h = i.toString(16);
  if (h.length % 2) h = "0" + h;
  const raw = new Uint8Array(Buffer.from(h, "hex"));
  if (len === 0) return raw;
  if (raw.length > len) fail("integer does not fit the modulus length");
  const out = new Uint8Array(len);
  out.set(raw, len - raw.length);
  return out;
}

export const bigBitLength = (i: bigint): number => (i === 0n ? 0 : i.toString(2).length);

function b64Int(s: string, what: string): bigint {
  const b = b64urlBytes(s);
  if (!b) return fail(`${what} is not base64url`);
  return bytesToBig(b!);
}

/** A decoded RSA public key; `k` is the modulus length in bytes. */
export interface DecodedPublic {
  n: bigint;
  e: bigint;
  k: number;
}

/** Decodes and sanity-checks a share's public half (a usable 2048+ bit RSA key). */
export function decodePublic(entry: { n: string; e: string }): DecodedPublic {
  const n = b64Int(entry.n, "share modulus");
  const e = b64Int(entry.e, "share exponent");
  if (bigBitLength(n) < 2048 || (n & 1n) === 0n || e < 3n || e >= 1n << 63n) {
    fail("share public key is not a usable RSA key");
  }
  return { n, e, k: Math.ceil(bigBitLength(n) / 8) };
}

/** EMSA-PKCS1-v1_5 encoding of a SHA-256 digest into a k-byte block, as an integer. */
function emsaInt(digest: Uint8Array, k: number): bigint {
  const t = new Uint8Array(SHA256_DIGEST_INFO.length + digest.length);
  t.set(SHA256_DIGEST_INFO, 0);
  t.set(digest, SHA256_DIGEST_INFO.length);
  if (digest.length !== 32 || k < t.length + 11) fail("modulus too short for the signature encoding");
  const em = new Uint8Array(k);
  em[1] = 0x01;
  for (let i = 2; i < k - t.length - 1; i++) em[i] = 0xff;
  em.set(t, k - t.length);
  return bytesToBig(em);
}

/** Square-and-multiply for a PUBLIC exponent (the s^e == m check). */
function modPowPublic(base: bigint, exp: bigint, mod: bigint): bigint {
  let r = 1n;
  let b = base % mod;
  for (let e = exp; e > 0n; e >>= 1n) {
    if (e & 1n) r = (r * b) % mod;
    b = (b * b) % mod;
  }
  return r;
}

const sha256 = (data: string | Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(data).digest());

/** Multiplies RI's partial by the partner partial over `digest` and checks s^e == m. */
function completeDigest(entry: ShareEntry, digest: Uint8Array, partialRi: Uint8Array): Uint8Array {
  const pub = decodePublic(entry);
  const dP = b64urlBytes(entry.d_partner);
  if (!dP) fail("share d_partner is not base64url");
  const m = emsaInt(digest, pub.k);
  const sRi = bytesToBig(partialRi);
  if (partialRi.length === 0 || sRi === 0n || sRi >= pub.n) fail("RealmID's partial signature is out of range");
  const s = (sRi * ctExp(m, dP!, pub.n)) % pub.n;
  if (modPowPublic(s, pub.e, pub.n) !== m) {
    fail("the finished signature does not verify under the pinned key; refusing to release it");
  }
  return bigToBytes(s, pub.k);
}

/**
 * Multiplies RI's partial with the partner partial computed from `entry` over the
 * EMSA-PKCS1-v1_5/SHA-256 encoding of `signingInput`, checks s^e == m, and returns s. A partial that
 * is corrupt, for another message, or made for another key rejects and returns no bytes.
 */
export async function completePartial(entry: ShareEntry, signingInput: string, partialRi: Uint8Array): Promise<Uint8Array> {
  return completeDigest(entry, sha256(signingInput), partialRi);
}

/**
 * Completes the R36/R93 handshake signature: the message is
 * sha256("realmid-split-handshake/v1|" + realm + "|" + kid + "|" + nonce), used directly as the
 * digest (so the result verifies with a stock RSA verifier over that digest). RealmID never
 * half-signs a caller-chosen message: the SDK recomputes the message from the nonce itself.
 */
export async function completeHandshake(
  entry: ShareEntry, realm: string, kid: string, nonce: string, partialRi: Uint8Array,
): Promise<Uint8Array> {
  return completeDigest(entry, sha256(`realmid-split-handshake/v1|${realm}|${kid}|${nonce}`), partialRi);
}

function jsonPart(b64: string, what: string): Record<string, unknown> {
  const raw = b64urlBytes(b64);
  if (!raw) return fail(`partial signing ${what} is not base64url`);
  try {
    const v: unknown = JSON.parse(new TextDecoder().decode(raw));
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    // fall through to the single refusal below
  }
  return fail(`partial signing ${what} is not JSON`);
}

/**
 * Refuses a header that is not an RS256 access token for kid `p.kid`, or a payload whose `iss` is not
 * `expectIssuer`; completes the JWT, verifies it under `entry`'s public key and only then returns it
 * (verify-before-release).
 */
export async function coSign(entry: ShareEntry, expectIssuer: string, p: PartialSigning): Promise<string> {
  const hdr = jsonPart(p.header, "header");
  const typ = typeof hdr["typ"] === "string" ? (hdr["typ"] as string).toLowerCase() : undefined;
  if (hdr["alg"] !== "RS256" || typ === undefined || !["jwt", "at+jwt", "application/at+jwt"].includes(typ)) {
    fail("refusing to co-sign a token with a foreign alg or typ");
  }
  if (p.kid && typeof hdr["kid"] === "string" && hdr["kid"] && hdr["kid"] !== p.kid) {
    fail("partial signing kid does not match the header");
  }
  const pl = jsonPart(p.payload, "payload");
  if (typeof pl["iss"] !== "string" || pl["iss"] === "" || pl["iss"] !== expectIssuer) {
    fail("refusing to co-sign a token for a foreign issuer");
  }
  const ri = b64urlBytes(p.partialRi);
  if (!ri) return fail("partial_ri is not base64url");
  const sig = await completePartial(entry, `${p.header}.${p.payload}`, ri!);
  return `${p.header}.${p.payload}.${b64urlEncode(sig)}`;
}

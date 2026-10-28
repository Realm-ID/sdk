/**
 * Partner-side split-key rotation and lost-half recovery (SPEC §14.5, §14.12; R63, R67.3, R72, R91,
 * R92). Every call here carries the platform token and NO actor: rotation routes are no-actor. The
 * handshake challenge is `{nonce, partial_ri}`; the answer is `{sig}` in base64url over
 * sha256("realmid-split-handshake/v1|realm|kid|nonce") (R93, SPEC §14.6). Mirrors `sdk/go/rotation.go`.
 */

import { generateKeyPair, randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { RealmError } from "./errors.js";
import type { Realm } from "./realm.js";
import { internalsOf } from "./realm-internals.js";
import { b64urlBytes, b64urlEncode, bigBitLength, bigToBytes, bytesToBig, completeHandshake } from "./cosign.js";
import { isWritable, ShareEntry, type PreviousKey, type ShareBundle, type ShareSource } from "./share-source.js";

export interface RotateSplitOptions {
  kid: string;
  /** Lost-half recovery: keeps no previous key, and the lease body says so (R92). */
  recovery?: boolean;
}

const genKeyPair = promisify(generateKeyPair);

const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? a : gcd(b, a % b));

/** A uniform random integer in [0, max). */
function randomBelow(max: bigint): bigint {
  const bits = bigBitLength(max);
  const bytes = Math.ceil(bits / 8);
  const excess = BigInt(bytes * 8 - bits);
  for (;;) {
    const v = bytesToBig(new Uint8Array(randomBytes(bytes))) >> excess;
    if (v < max) return v;
  }
}

/** Splits an RSA private exponent d = d_ri + d_partner (mod lambda(n)). */
function splitExponent(jwk: { d: string; p: string; q: string }): { dRi: bigint; dP: bigint } {
  const dec = (s: string): bigint => bytesToBig(new Uint8Array(Buffer.from(s, "base64url")));
  const p1 = dec(jwk.p) - 1n;
  const q1 = dec(jwk.q) - 1n;
  const lam = (p1 * q1) / gcd(p1, q1);
  const d = dec(jwk.d) % lam;
  const dRi = randomBelow(lam);
  return { dRi, dP: (((d - dRi) % lam) + lam) % lam };
}

const wire = (i: bigint): string => b64urlEncode(bigToBytes(i));

/**
 * lease -> keygen -> store -> upload d_ri -> handshake -> complete on a WRITABLE share source. The new
 * share is stored BEFORE the upload so a crash never strands a key whose other half RealmID already
 * holds. A failed handshake rejects and is never retried here (an unattended loop would burn the
 * emergency-rotation cap). After the handshake succeeds the bundle is compacted: the new share is the
 * only current one and, unless `recovery` is set, the retired key stays trusted until `trust_until`
 * (R91). A read-only source (environment) fails with `share_source_read_only` and sends nothing.
 */
export async function rotateSplit(realm: Realm, store: ShareSource, opts: RotateSplitOptions): Promise<void> {
  if (!isWritable(store)) {
    throw new RealmError({
      code: "share_source_read_only",
      message: "realmid: this share source is read-only; rotate with the CLI, then reload the bundle",
    });
  }
  if (!opts || !opts.kid) throw new RealmError({ code: "bad_request", message: "realmid: rotateSplit needs a kid" });
  const ih = internalsOf(realm);
  if (!ih) throw new RealmError({ code: "invalid_config", message: "realmid: rotateSplit needs a realm made by createRealm" });
  const http = ih.http.withUserToken(""); // no actor on any rotation call (R67.3)

  const { bundle: cur } = await store.load();
  const base = `/platforms/${encodeURIComponent(ih.realmId)}/signing-keys/split`;
  // R92: the issuer applies the recovery cap, audit and contact email from this reason.
  await http.request({ method: "POST", path: `${base}/rotation-lease`, body: { reason: opts.recovery ? "recovery" : "rotation" } });

  const kp = await genKeyPair("rsa", { modulusLength: 2048, publicExponent: 0x10001 });
  const jwk = kp.privateKey.export({ format: "jwk" }) as { n: string; e: string; d: string; p: string; q: string };
  const { dRi, dP } = splitExponent(jwk);
  const n = bytesToBig(new Uint8Array(Buffer.from(jwk.n, "base64url")));
  const e = bytesToBig(new Uint8Array(Buffer.from(jwk.e, "base64url")));
  const entry = new ShareEntry({ n: wire(n), e: wire(e), d_partner: wire(dP) });

  const next: ShareBundle = {
    realm: cur.realm || ih.realmId,
    shares: { ...cur.shares, [opts.kid]: entry },
    previous: [...(cur.previous ?? [])],
  };
  try {
    await store.store(next);
  } catch (err) {
    throw new RealmError({ code: "server_error", message: `realmid: store the new share: ${(err as Error).message}`, cause: err });
  }

  await http.request({ method: "POST", path: base, body: { kid: opts.kid, n: entry.n, e: entry.e, d_ri: wire(dRi) } });
  const kidPath = `${base}/${encodeURIComponent(opts.kid)}`;
  const ch = await http.request<{ nonce?: string; partial_ri?: string }>({ method: "POST", path: `${kidPath}/handshake` });
  const ri = typeof ch?.partial_ri === "string" ? b64urlBytes(ch.partial_ri) : undefined;
  if (!ri || typeof ch.nonce !== "string") {
    throw new RealmError({ code: "server_error", message: "realmid: handshake challenge is malformed" });
  }
  const sig = await completeHandshake(entry, ih.realmId, opts.kid, ch.nonce, ri);
  await http.request({ method: "POST", path: `${kidPath}/handshake/complete`, body: { sig: b64urlEncode(sig) } });

  // Handshake done: the new key is the one current share.
  const final: ShareBundle = { realm: next.realm, shares: { [opts.kid]: entry } };
  if (!opts.recovery) {
    const until = Math.floor(ih.now() / 1000) + (ih.split?.trustWindowSeconds() ?? 15 * 60 + 5 * 60);
    final.previous = [...(cur.previous ?? [])];
    for (const [kid, s] of Object.entries(cur.shares)) {
      if (kid !== opts.kid) final.previous.push({ kid, n: s.n, e: s.e, trust_until: until } satisfies PreviousKey);
    }
  }
  try {
    await store.store(final);
  } catch (err) {
    throw new RealmError({
      code: "server_error",
      message: `realmid: the new key is active at RealmID but the bundle could not be compacted: ${(err as Error).message}`,
      cause: err,
    });
  }
}

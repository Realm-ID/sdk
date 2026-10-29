/**
 * Browser dealer (SPEC §14.15): generates an RSA-2048 key with WebCrypto, splits its private
 * exponent (§14.14, modulo lambda(n)), and returns RealmID's half (for `uploadSplitKey`) and the
 * partner's half (a plain ShareBundle to download). Keeps nothing: no module state, no storage,
 * no logging. First split only.
 */

import { RealmError } from "@realm-id/sdk";

import { b64uToBig, bigToB64u, splitExponent } from "./split-math.js";

export interface SplitKeyUpload {
  kid: string;
  n: string;
  e: string;
  d_ri: string;
}

export interface SplitShareBundle {
  realm: string;
  shares: Record<string, { n: string; e: string; d_partner: string }>;
}

export interface DealtSplitKey {
  kid: string;
  /** The partner half (§14.14 ShareBundle). Plain JSON object; holds d_partner. */
  share: SplitShareBundle;
  /** JSON.stringify(share), the exact bytes to download. */
  shareJson: string;
  /** "realmid-share-<realm>-<kid>.json" */
  filename: string;
  /** RealmID's half, the body for uploadSplitKey. */
  upload: SplitKeyUpload;
}

const UNSUPPORTED = "split_keygen_unsupported";

function unsupported(message: string, cause?: unknown): RealmError {
  return new RealmError({ code: "invalid_config", message, details: { reason: UNSUPPORTED }, cause });
}

/** True when the browser cannot generate or export an RSA key (the console then shows the CLI commands). */
export function isSplitKeygenUnsupported(err: unknown): boolean {
  if (!(err instanceof RealmError)) return false;
  if (err.code !== "invalid_config") return false;
  return (err.details as Record<string, unknown> | undefined)?.["reason"] === UNSUPPORTED;
}

function defaultKid(c: Crypto, now: Date): string {
  const ymd = now.toISOString().slice(0, 10).replace(/-/g, "");
  const r = c.getRandomValues(new Uint8Array(4));
  let hex = "";
  for (const b of r) hex += b.toString(16).padStart(2, "0");
  return `split-${ymd}-${hex}`;
}

export async function dealSplitKey(opts: { realm: string; kid?: string; crypto?: Crypto }): Promise<DealtSplitKey> {
  const realm = opts.realm;
  if (typeof realm !== "string" || realm.trim() === "") {
    throw new RealmError({ code: "bad_request", message: "dealSplitKey needs a realm id" });
  }
  if (opts.kid !== undefined && opts.kid.trim() === "") {
    throw new RealmError({ code: "bad_request", message: "dealSplitKey: kid must not be empty" });
  }
  const c = opts.crypto ?? (globalThis as { crypto?: Crypto }).crypto;
  if (!c?.subtle?.generateKey || !c.subtle.exportKey || typeof c.getRandomValues !== "function") {
    throw unsupported("WebCrypto RSA key generation is not available in this browser");
  }

  let jwk: JsonWebKey;
  try {
    const pair = (await c.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    jwk = await c.subtle.exportKey("jwk", pair.privateKey);
  } catch (cause) {
    throw unsupported("WebCrypto could not generate or export an RSA key", cause);
  }
  if (!jwk?.n || !jwk.e || !jwk.d || !jwk.p || !jwk.q) {
    throw unsupported("the exported RSA key lacks d, p or q");
  }

  const kid = (opts.kid ?? defaultKid(c, new Date())).trim();
  const { dRi, dP } = splitExponent(b64uToBig(jwk.p), b64uToBig(jwk.q), b64uToBig(jwk.d), (a) =>
    c.getRandomValues(a),
  );

  const share: SplitShareBundle = { realm, shares: { [kid]: { n: jwk.n, e: jwk.e, d_partner: bigToB64u(dP) } } };
  return {
    kid,
    share,
    shareJson: JSON.stringify(share),
    filename: `realmid-share-${realm}-${kid}.json`,
    upload: { kid, n: jwk.n, e: jwk.e, d_ri: bigToB64u(dRi) },
  };
}

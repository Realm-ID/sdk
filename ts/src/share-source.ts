/**
 * Share custody for a split-signing realm (SPEC §14.5): the partner's half of each private exponent
 * (`d_partner`) plus the public keys the verifier pins. Core sources use only `node:` builtins:
 * environment (read-only) and file (atomic rename, mode 0600, KEK required outside local dev). GSM
 * and Redis + KEK are add-ons (`@realm-id/sdk-secrets-*`). A share is never logged or printed.
 *
 * At-rest format when a KEK is set is the share envelope v1 (R93): AES-256-GCM, random 96-bit
 * nonce, AAD = UTF-8 `realmid-share/v1|<realm>|<kek_id>`, `kek_id` = first 16 hex of
 * sha256("realmid-kek-id/v1" || kek). The realm is an INPUT of the source, never read from the
 * envelope. Same format as `sdk/go/sharesource.go`.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { inspect } from "node:util";
import { RealmError } from "./errors.js";

const REDACTED = "[redacted]";

/**
 * One split key's partner half. `n`, `e`, `d_partner` are base64url big-endian integers (the wire
 * encoding of the upload route). `d_partner` is readable on the instance (the signer needs it) but is
 * NON-ENUMERABLE and every printing hook omits it, so String / JSON.stringify / util.inspect / spread
 * cannot print it. Persist a bundle with {@link serializeShareBundle}, which writes it explicitly.
 */
export class ShareEntry {
  readonly n: string;
  readonly e: string;
  declare readonly d_partner: string;

  constructor(init: { n: string; e: string; d_partner: string }) {
    this.n = init.n;
    this.e = init.e;
    Object.defineProperty(this, "d_partner", { value: init.d_partner, enumerable: false, writable: false });
  }

  toJSON(): { n: string; e: string } {
    return { n: this.n, e: this.e };
  }

  toString(): string {
    return `ShareEntry{n:${this.n} e:${this.e} d_partner:${REDACTED}}`;
  }

  [inspect.custom](): string {
    return this.toString();
  }
}

/** A retired split key still trusted until `trust_until` (unix seconds). */
export interface PreviousKey {
  kid: string;
  n: string;
  e: string;
  trust_until: number;
}

/** The partner's custody document. */
export interface ShareBundle {
  realm: string;
  shares: Record<string, ShareEntry>;
  previous?: PreviousKey[];
}

export interface LoadedShares {
  bundle: ShareBundle;
  /** Opaque; changes on every write. */
  version: string;
}

/** `{signal}` on every source call (SPEC §14.9); Java stays synchronous. */
export interface SourceCallOptions {
  signal?: AbortSignal;
}

export interface ShareSource {
  load(opts?: SourceCallOptions): Promise<LoadedShares>;
}

/** A source that can persist a new bundle (file, Redis; not env). */
export interface WritableShareSource extends ShareSource {
  store(bundle: ShareBundle, opts?: SourceCallOptions): Promise<string>;
}

/** True for a source with a write method (the env source has none). */
export function isWritable(src: ShareSource): src is WritableShareSource {
  return typeof (src as { store?: unknown }).store === "function";
}

/** Not-readable source: always `share_load_failed`, never `jwks_fetch_failed` (SPEC §14.4). */
export function loadFailed(message: string, cause?: unknown): RealmError {
  return new RealmError({ code: "share_load_failed", message: `realmid: ${message}`, cause });
}

export function shareVersion(raw: string | Uint8Array): string {
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

/** The explicit serialisation a store writes (the class hides `d_partner` from JSON on purpose). */
export function serializeShareBundle(b: ShareBundle): string {
  const shares: Record<string, { n: string; e: string; d_partner: string }> = {};
  for (const [kid, s] of Object.entries(b.shares)) shares[kid] = { n: s.n, e: s.e, d_partner: s.d_partner };
  return JSON.stringify({ realm: b.realm, shares, ...(b.previous && b.previous.length ? { previous: b.previous } : {}) });
}

const isStr = (v: unknown): v is string => typeof v === "string" && v !== "";

/** Parses a bundle document. The error text names no input bytes. */
export function parseShareBundle(raw: string): ShareBundle {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    throw loadFailed("share bundle is not valid JSON");
  }
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const sharesIn = (o["shares"] && typeof o["shares"] === "object" ? o["shares"] : {}) as Record<string, Record<string, unknown>>;
  const shares: Record<string, ShareEntry> = {};
  for (const [kid, s] of Object.entries(sharesIn)) {
    if (!s || !isStr(s["n"]) || !isStr(s["e"]) || !isStr(s["d_partner"])) {
      throw loadFailed(`share bundle entry ${JSON.stringify(kid)} is malformed`);
    }
    shares[kid] = new ShareEntry({ n: s["n"], e: s["e"], d_partner: s["d_partner"] });
  }
  const bundle: ShareBundle = { realm: typeof o["realm"] === "string" ? o["realm"] : "", shares };
  if (Array.isArray(o["previous"])) {
    bundle.previous = (o["previous"] as Record<string, unknown>[]).map((p) => {
      if (!p || !isStr(p["kid"]) || !isStr(p["n"]) || !isStr(p["e"]) || typeof p["trust_until"] !== "number") {
        throw loadFailed("share bundle previous key is malformed");
      }
      return { kid: p["kid"], n: p["n"], e: p["e"], trust_until: p["trust_until"] };
    });
  }
  return bundle;
}

/** Reads the bundle JSON from `envVar`. Read-only: it has no `store`, so rotation goes through the CLI. */
export function envShareSource(envVar: string, opts?: { env?: Record<string, string | undefined> }): ShareSource {
  return {
    async load(call?: SourceCallOptions): Promise<LoadedShares> {
      call?.signal?.throwIfAborted();
      const raw = (opts?.env ?? process.env)[envVar] ?? "";
      if (raw === "") throw loadFailed(`share bundle environment variable ${envVar} is not set`);
      return { bundle: parseShareBundle(raw), version: shareVersion(raw) };
    },
  };
}

export interface FileShareOptions {
  /** 32-byte key-encryption key; required unless `localDev`. */
  kek?: Uint8Array;
  /** Permits a plaintext file (no KEK) and nothing else does. */
  localDev?: boolean;
  /** The realm id the envelope is bound to (AAD, SPEC §14.5). Required with a KEK. */
  realm?: string;
}

interface Envelope {
  v: number;
  alg: string;
  kek_id: string;
  nonce: string;
  ct: string;
  ver?: string;
}

/** First 16 hex of sha256("realmid-kek-id/v1" || kek): every SDK and the CLI derive the same id. */
export function kekId(kek: Uint8Array): string {
  return createHash("sha256").update("realmid-kek-id/v1").update(kek).digest("hex").slice(0, 16);
}

const invalidConfig = (message: string): RealmError => new RealmError({ code: "invalid_config", message: `realmid: ${message}` });

/** Seals `plain` as an envelope v1 object (no `ver`). */
export function sealEnvelope(kek: Uint8Array, realm: string, plain: Uint8Array): Envelope {
  const id = kekId(kek);
  const nonce = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", kek, nonce);
  c.setAAD(Buffer.from(`realmid-share/v1|${realm}|${id}`));
  const ct = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
  return { v: 1, alg: "A256GCM", kek_id: id, nonce: nonce.toString("base64url"), ct: ct.toString("base64url") };
}

/** Opens an envelope v1 string; throws `share_load_failed`. A KEK id mismatch fails without decrypting. */
export function openEnvelope(kek: Uint8Array, realm: string, raw: string): Uint8Array {
  let env: Envelope;
  try {
    env = JSON.parse(raw) as Envelope;
  } catch {
    throw loadFailed("share file is not an encrypted bundle");
  }
  if (!env || env.v !== 1 || env.alg !== "A256GCM") throw loadFailed("share file is not an encrypted bundle");
  const id = kekId(kek);
  if (env.kek_id !== id) throw loadFailed(`share file is sealed under KEK ${JSON.stringify(env.kek_id)}, not the configured ${JSON.stringify(id)}`);
  const nonce = Buffer.from(String(env.nonce), "base64url");
  const ct = Buffer.from(String(env.ct), "base64url");
  if (nonce.length !== 12 || ct.length < 16) throw loadFailed("share file envelope is malformed");
  try {
    const d = createDecipheriv("aes-256-gcm", kek, nonce);
    d.setAAD(Buffer.from(`realmid-share/v1|${realm}|${id}`));
    d.setAuthTag(ct.subarray(ct.length - 16));
    return new Uint8Array(Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]));
  } catch {
    throw loadFailed("share file did not decrypt (wrong KEK or realm?)");
  }
}

/**
 * The atomic-rename, mode-0600 file store. A KEK (32 bytes) plus `realm` encrypts the bundle as an
 * envelope v1; without a KEK the constructor throws `invalid_config` unless `localDev` is set.
 */
export function fileShareSource(path: string, opts: FileShareOptions): WritableShareSource {
  const kek = opts.kek && opts.kek.length > 0 ? new Uint8Array(opts.kek) : undefined;
  if (kek) {
    if (kek.length !== 32) throw invalidConfig("the share-file KEK must be 32 bytes");
    if (!opts.realm) throw invalidConfig("a share file with a KEK needs FileShareOptions.realm (the envelope is bound to the realm)");
  } else if (!opts.localDev) {
    throw invalidConfig("a share file needs a KEK outside local development (FileShareOptions.kek)");
  }
  const realm = opts.realm ?? "";
  // One writer at a time per source instance (Go: a mutex).
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn);
    chain = next.catch(() => undefined);
    return next;
  };

  return {
    load: (call) => serial(async () => {
      call?.signal?.throwIfAborted();
      let raw: string;
      try {
        raw = await fs.readFile(path, "utf8");
      } catch (e) {
        throw loadFailed(`read share file: ${(e as Error).message}`, e);
      }
      const plain = kek ? new TextDecoder().decode(openEnvelope(kek, realm, raw)) : raw;
      return { bundle: parseShareBundle(plain), version: shareVersion(raw) };
    }),

    store: (bundle, call) => serial(async () => {
      call?.signal?.throwIfAborted();
      const plain = serializeShareBundle(bundle);
      const out = kek ? JSON.stringify(sealEnvelope(kek, realm, new TextEncoder().encode(plain))) : plain;
      const tmp = join(dirname(path), `.shares-${randomBytes(6).toString("hex")}`);
      let fh: fs.FileHandle | undefined;
      try {
        fh = await fs.open(tmp, "wx", 0o600);
        await fh.chmod(0o600);
        await fh.writeFile(out);
        await fh.sync();
        await fh.close();
        fh = undefined;
        await fs.rename(tmp, path);
      } catch (e) {
        await fh?.close().catch(() => undefined);
        await fs.rm(tmp, { force: true }).catch(() => undefined);
        throw new RealmError({ code: "server_error", message: `realmid: write share file: ${(e as Error).message}`, cause: e });
      }
      return shareVersion(out);
    }),
  };
}

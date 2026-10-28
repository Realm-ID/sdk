/**
 * A split realm's view of its share bundle (SPEC §14.4, R39). The verifier trusts ONLY the public
 * keys here (plus a previous key until its `trust_until`) and never fetches RealmID's JWKS; a kid the
 * bundle does not pin is `unpinned_kid`. The same state finishes a `/auth/token/partial` answer.
 * Same behaviour as `sdk/go/trust.go` and `sdk/go/split_token.go`.
 */

import { RealmError } from "./errors.js";
import type { Logger } from "./logger.js";
import { coSign, decodePublic } from "./cosign.js";
import { loadFailed, type ShareBundle, type ShareEntry, type ShareSource } from "./share-source.js";

/** Rate limit on the re-read an unknown kid triggers, so forged kids cannot hammer the custody store. */
const RELOAD_MIN_MS = 5_000;
/** The poll that picks up a rotation made by another pod. */
const REFRESH_EVERY_MS = 30_000;
/** R91: a retired key stays trusted for one access-token lifetime (never less than this) plus slack. */
const TTL_FLOOR_SECONDS = 15 * 60;
const TTL_SLACK_SECONDS = 5 * 60;

interface KeyInfo {
  n: string;
  e: string;
  /** 0 = current key; otherwise unix seconds it stops being trusted. */
  trustUntil: number;
  key?: Promise<CryptoKey>;
}

export class SplitState {
  private bundle?: ShareBundle;
  private keys = new Map<string, KeyInfo>();
  private lastAttempt = 0;
  private inflight?: Promise<void>;
  private seenTtlSeconds = 0;

  constructor(
    private readonly src: ShareSource,
    private readonly expectedIssuer: string,
    private readonly nowMs: () => number,
    private readonly logger: Logger,
  ) {}

  private reload(): Promise<void> {
    if (this.inflight) return this.inflight;
    this.lastAttempt = this.nowMs();
    this.inflight = (async () => {
      let loaded;
      try {
        loaded = await this.src.load();
      } catch (e) {
        throw e instanceof RealmError ? e : loadFailed(`split share source: ${(e as Error).message}`, e);
      }
      if (!loaded || !loaded.bundle) throw loadFailed("split share source returned no bundle");
      const keys = new Map<string, KeyInfo>();
      for (const [kid, s] of Object.entries(loaded.bundle.shares)) {
        decodePublic(s); // refuses an unusable key
        keys.set(kid, { n: s.n, e: s.e, trustUntil: 0 });
      }
      for (const p of loaded.bundle.previous ?? []) {
        if (keys.has(p.kid)) continue;
        decodePublic(p);
        keys.set(p.kid, { n: p.n, e: p.e, trustUntil: p.trust_until });
      }
      this.bundle = loaded.bundle;
      this.keys = keys;
    })().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  /** The loaded bundle: loaded on first use, re-read when the poll interval has passed. */
  private async current(): Promise<ShareBundle> {
    if (!this.bundle || this.nowMs() - this.lastAttempt >= REFRESH_EVERY_MS) {
      try {
        await this.reload();
      } catch (e) {
        if (!this.bundle) throw e instanceof RealmError ? e : loadFailed((e as Error).message, e);
        this.logger.warn("realmid split share reload failed; keeping the loaded bundle", { message: (e as Error).message });
      }
    }
    return this.bundle!;
  }

  private async rereadOnUnknown(): Promise<void> {
    if (this.nowMs() - this.lastAttempt >= RELOAD_MIN_MS) await this.reload().catch(() => undefined);
  }

  private unpinned(kid: string, verify: boolean): RealmError {
    return new RealmError({
      code: "unpinned_kid",
      message: `signing kid ${JSON.stringify(kid)} is not ${verify ? "pinned by" : "in"} the share bundle`,
      ...(verify ? { httpStatus: 401 } : {}),
    });
  }

  /** The partner share for `kid` (a CURRENT key only: a previous key has no `d_partner`). */
  async entry(kid: string): Promise<ShareEntry> {
    let b = await this.current();
    if (!b.shares[kid]) {
      await this.rereadOnUnknown();
      b = this.bundle!;
    }
    const e = b.shares[kid];
    if (!e) throw this.unpinned(kid, false);
    return e;
  }

  /** The verifying key for `kid` from the bundle only (never RealmID's JWKS). */
  async publicKey(kid: string): Promise<CryptoKey> {
    await this.current();
    let info = this.keys.get(kid);
    if (!info) {
      await this.rereadOnUnknown();
      info = this.keys.get(kid);
    }
    if (info && info.trustUntil !== 0 && Math.floor(this.nowMs() / 1000) >= info.trustUntil) info = undefined;
    if (!info) {
      this.logger.error("realmid verify refused an unpinned kid", { kid });
      throw this.unpinned(kid, true);
    }
    info.key ??= globalThis.crypto.subtle.importKey(
      "jwk",
      { kty: "RSA", n: info.n, e: info.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    return info.key;
  }

  /** Turns a `/auth/token/partial` body into a normal mint body with a finished, verified JWT. */
  async finish(raw: unknown): Promise<Record<string, unknown>> {
    const w = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const s = w["signing"] as Record<string, unknown> | undefined;
    if (!s || w["token_type"] !== "partial" || typeof s["kid"] !== "string") {
      throw new RealmError({
        code: "server_error",
        message: "realmid: a split realm's token endpoint answered without a partial signature",
      });
    }
    const entry = await this.entry(s["kid"] as string);
    const jwt = await coSign(entry, this.expectedIssuer, {
      kid: s["kid"] as string,
      header: String(s["header"] ?? ""),
      payload: String(s["payload"] ?? ""),
      partialRi: String(s["partial_ri"] ?? ""),
    });
    const out: Record<string, unknown> = { ...w, access_token: jwt };
    delete out["signing"];
    if (typeof w["expires_in"] === "number" && w["expires_in"] > this.seenTtlSeconds) this.seenTtlSeconds = w["expires_in"];
    return out;
  }

  /** R91: the longest `expires_in` seen on a co-signed mint (floor 15 min) plus 5 minutes of slack. */
  trustWindowSeconds(): number {
    return Math.max(this.seenTtlSeconds, TTL_FLOOR_SECONDS) + TTL_SLACK_SECONDS;
  }
}

/**
 * Realm handle factory — SPEC §1. Wires the auth/tenants/domains/info/
 * api-keys/config/verifier surfaces around a single HttpClient + Verifier
 * pair, with a PlatformTokenManager (§4.0) sitting between the API key
 * and every outbound call.
 */

import { HttpClient } from "./http.js";
import { Verifier, type VerifyOptions } from "./verifier.js";
import type { Claims } from "./claims.js";
import { AuthClient } from "./auth.js";
import { TenantsClient } from "./tenants.js";
import { DomainsClient } from "./domains.js";
import { InfoClient, type RealmInfo } from "./info.js";
import { ApiKeysClient } from "./api-keys.js";
import { ConfigClient } from "./config.js";
import { RolesClient } from "./roles.js";
import { createMiddleware, type ConnectMiddleware, type MiddlewareConfig } from "./middleware.js";
import { RealmError } from "./errors.js";
import { PlatformTokenManager } from "./platform-token-manager.js";
import type { Logger } from "./logger.js";
import { NOOP_LOGGER } from "./logger.js";
import type { RevocationCache } from "./revocation.js";

export interface RealmConfig {
  /** Your realm's id (UUID-ish string). Required. */
  realmId: string;
  /**
   * Realm API key (`rk_live_...`). **Required** — used for every
   * operation, including login. The SDK exchanges it for short-lived
   * platform tokens internally; your raw API key never crosses login
   * traffic (SPEC §4.0).
   */
  apiKey: string;
  /** Defaults to "https://auth.realmid.dev". */
  baseUrl?: string;
  /**
   * Origin host the SDK announces on auth calls. If unset, derived from
   * the realm's claimed domain via `realm.info()`. Override per-call on
   * `auth.login()` etc.
   */
  origin?: string;
  fetch?: typeof fetch;
  /** JWKS cache TTL. Default 10m. */
  cacheTtlMs?: number;
  /** Verifier clock skew. Default 30s. */
  leewaySeconds?: number;
  /** Clock override for tests. */
  clock?: () => Date;
  /** Pin verify audience; otherwise SDK auto-discovers via realm.info(). */
  audience?: string;
  /** Structured logger (SPEC §9). Default no-op. `console` works. */
  logger?: Logger;
  /** Middleware refresh-token delivery default (SPEC §10.2). */
  tokenDelivery?: "cookie" | "body";
  /**
   * Optional shared revocation cache consulted by `verify()` after
   * signature + claim checks (ADR-041 follow-up). Lets partners stop
   * the bleed on stolen access tokens between user logout and natural
   * JWT expiry. Nil → no-op; verifier behaves as before. Pass
   * `new MemRevocationCache()` for a single-process default, or supply
   * a Redis/memcached-backed implementation for multi-replica deploys.
   */
  revocation?: RevocationCache;
}

export interface Realm {
  readonly realmId: string;
  readonly baseUrl: string;
  readonly auth: AuthClient;
  readonly tenants: TenantsClient;
  readonly domains: DomainsClient;
  readonly apiKeys: ApiKeysClient;
  readonly config: ConfigClient;
  readonly roles: RolesClient;
  readonly tokenDelivery: "cookie" | "body";
  /** Configured RevocationCache, or undefined when not wired. */
  readonly revocation?: RevocationCache;
  info(): Promise<RealmInfo>;
  verify(token: string, opts?: VerifyOptions): Promise<Claims>;
  middleware(cfg?: MiddlewareConfig): ConnectMiddleware;
}

const DEFAULT_BASE_URL = "https://auth.realmid.dev";

export function createRealm(cfg: RealmConfig): Realm {
  if (!cfg.realmId) {
    throw new RealmError({ code: "bad_request", message: "realmid: realmId required" });
  }
  if (!cfg.apiKey) {
    throw new RealmError({
      code: "bad_request",
      message: "realmid: apiKey required (SPEC §1) — every operation, including login, uses the dual-token exchange",
    });
  }
  const baseUrl = (cfg.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const logger = cfg.logger ?? NOOP_LOGGER;
  const fetchImpl = cfg.fetch ?? globalThis.fetch.bind(globalThis);

  const platformTokens = new PlatformTokenManager({
    apiKey: cfg.apiKey,
    baseUrl,
    realmId: cfg.realmId,
    fetch: fetchImpl,
    logger,
  });

  const http = new HttpClient({
    baseUrl,
    fetch: fetchImpl,
    platformTokens,
    logger,
  });

  const info = new InfoClient(http, cfg.realmId);

  // Origin resolver shared by auth + middleware (SPEC §8).
  const originResolver = async (perCall?: string): Promise<string | undefined> => {
    if (perCall) return perCall;
    if (cfg.origin) return cfg.origin;
    try {
      const i = await info.get();
      const host = i.audience || i.domain;
      if (typeof host === "string" && host.length > 0) {
        return host.startsWith("http://") || host.startsWith("https://")
          ? host
          : `https://${host}`;
      }
    } catch {
      // discovery failed; fall through to no Origin header
    }
    return undefined;
  };

  const verifier = new Verifier({
    baseUrl,
    audience: cfg.audience,
    revocation: cfg.revocation,
    audienceResolver: cfg.audience
      ? undefined
      : async (_realmId) => {
          const i = await info.get();
          if (!i.audience) {
            throw new RealmError({
              code: "wrong_audience",
              message: "audience auto-discovery failed (no realm metadata)",
            });
          }
          return i.audience;
        },
    fetch: fetchImpl,
    cacheTtlMs: cfg.cacheTtlMs,
    leewaySeconds: cfg.leewaySeconds,
    now: cfg.clock,
    logger,
  });

  const handle: Realm = {
    realmId: cfg.realmId,
    baseUrl,
    tokenDelivery: cfg.tokenDelivery ?? "cookie",
    revocation: cfg.revocation,
    auth: new AuthClient(http, cfg.realmId, originResolver, cfg.revocation),
    tenants: new TenantsClient(http, cfg.realmId),
    domains: new DomainsClient(http),
    apiKeys: new ApiKeysClient(http, cfg.realmId),
    config: new ConfigClient(http, cfg.realmId),
    roles: new RolesClient(http, cfg.realmId),
    info: () => info.get(),
    verify: (token, opts) => verifier.verify(token, opts),
    middleware: (mwCfg) => createMiddleware(handle, mwCfg),
  };
  return handle;
}

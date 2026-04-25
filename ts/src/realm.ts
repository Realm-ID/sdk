/**
 * Realm handle factory — SPEC §1. Wires the auth/tenants/domains/platforms/
 * realm-self/verifier surfaces around a single HttpClient + Verifier pair.
 */

import { HttpClient } from "./http.js";
import { Verifier, type VerifyOptions } from "./verifier.js";
import type { Claims } from "./claims.js";
import { AuthClient } from "./auth.js";
import { TenantsClient } from "./tenants.js";
import { DomainsClient } from "./domains.js";
import { PlatformsClient } from "./platforms.js";
import { RealmSelfClient } from "./realm-self.js";
import { createMiddleware, type ConnectMiddleware, type MiddlewareConfig } from "./middleware.js";
import { RealmError } from "./errors.js";

export interface RealmConfig {
  realmId: string;
  apiKey?: string;
  /** Defaults to "https://auth.realmid.dev". */
  baseUrl?: string;
  fetch?: typeof fetch;
  /** JWKS cache TTL. Default 10m. */
  cacheTtlMs?: number;
  /** Verifier clock skew. Default 30s. */
  leewaySeconds?: number;
  /** Clock override for tests. */
  clock?: () => Date;
  /** Pin verify audience; otherwise SDK auto-discovers via realm.info(). */
  audience?: string;
}

export interface Realm {
  readonly realmId: string;
  readonly baseUrl: string;
  readonly auth: AuthClient;
  readonly tenants: TenantsClient;
  readonly domains: DomainsClient;
  readonly platforms: PlatformsClient;
  readonly realm: RealmSelfClient;
  verify(token: string, opts?: VerifyOptions): Promise<Claims>;
  middleware(cfg?: MiddlewareConfig): ConnectMiddleware;
}

const DEFAULT_BASE_URL = "https://auth.realmid.dev";

export function createRealm(cfg: RealmConfig): Realm {
  if (!cfg.realmId) {
    throw new RealmError({ code: "bad_request", message: "realmid: realmId required" });
  }
  const baseUrl = (cfg.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const http = new HttpClient({ baseUrl, fetch: cfg.fetch, apiKey: cfg.apiKey });
  const realmSelf = new RealmSelfClient(http, cfg.realmId, !!cfg.apiKey);

  const verifier = new Verifier({
    baseUrl,
    audience: cfg.audience,
    audienceResolver: cfg.audience
      ? undefined
      : async (_realmId) => {
          const info = await realmSelf.info();
          if (!info.audience) {
            throw new RealmError({
              code: "wrong_audience",
              message: "audience auto-discovery failed (no API key or realm metadata)",
            });
          }
          return info.audience;
        },
    fetch: cfg.fetch,
    cacheTtlMs: cfg.cacheTtlMs,
    leewaySeconds: cfg.leewaySeconds,
    now: cfg.clock,
  });

  const handle: Realm = {
    realmId: cfg.realmId,
    baseUrl,
    auth: new AuthClient(http, cfg.realmId),
    tenants: new TenantsClient(http),
    domains: new DomainsClient(http),
    platforms: new PlatformsClient(http),
    realm: realmSelf,
    verify: (token, opts) => verifier.verify(token, opts),
    middleware: (mwCfg) => createMiddleware(handle, mwCfg),
  };
  return handle;
}

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
import { SigningKeysClient } from "./signing-keys.js";
import { IdentityProviderConfigClient } from "./identity-provider-config.js";
import { IdentityProvidersClient } from "./identity-providers.js";
import { OriginsClient } from "./origins.js";
import { TokensClient } from "./tokens.js";
import { AdminClient } from "./admin.js";
import { AuditEventsClient } from "./audit-events.js";
import { OtpClient } from "./otp.js";
import { ServiceAccountsClient } from "./service-accounts.js";
import { SourcesClient } from "./sources.js";
import { createMiddleware, type ConnectMiddleware, type MiddlewareConfig } from "./middleware.js";
import { RealmError } from "./errors.js";
import { PlatformTokenManager } from "./platform-token-manager.js";
import type { CredentialSource } from "./credential.js";
import { staticApiKey, autoDetectCredential, DEFAULT_FEDERATION_AUDIENCE } from "./credential.js";
import type { Logger } from "./logger.js";
import { NOOP_LOGGER } from "./logger.js";
import type { RevocationCache } from "./revocation.js";

export interface RealmConfig {
  /** Your realm's id (UUID-ish string). Required. */
  realmId: string;
  /**
   * Realm API key (`rk_live_...`). Sugar for `credential =
   * staticApiKey(apiKey)`. Optional when `credential` is set or when an
   * ambient workload identity is available (ADR-057); required otherwise.
   * The SDK exchanges it for short-lived platform tokens internally; your
   * raw API key never crosses login traffic (SPEC §4.0).
   */
  apiKey?: string;
  /**
   * Overrides how the SDK bootstraps its platform session (ADR-057). Leave
   * unset to use `apiKey`, or — when `apiKey` is also unset — to auto-detect
   * an ambient workload identity (GCP / GitHub Actions). Set explicitly via
   * `staticApiKey` / `googleWorkloadIdentity` / `githubActionsOidc`.
   */
  credential?: CredentialSource;
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
  /** Owner-facing signing-key read + self-serve rotate. */
  readonly signingKeys: SigningKeysClient;
  /**
   * Realm-admin CRUD for social/OIDC identity-provider configs. Distinct
   * from the public IdP discovery surface.
   */
  readonly identityProviderConfig: IdentityProviderConfigClient;
  /** Public IdP discovery (SPEC §6.10) — the login provider list for SPAs. */
  readonly identityProviders: IdentityProvidersClient;
  readonly origins: OriginsClient;
  readonly tokens: TokensClient;
  readonly admin: AdminClient;
  /** Partner audit-event feed (ADR-055). */
  readonly auditEvents: AuditEventsClient;
  /** Partner OTP primitive (issue / view / verify). See proposal in auth repo. */
  readonly otp: OtpClient;
  /** Owner/admin service-account surface (ADR-071). */
  readonly serviceAccounts: ServiceAccountsClient;
  /** Owner/admin app/source registry (ADR-072). */
  readonly sources: SourcesClient;
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
  const baseUrl = (cfg.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const logger = cfg.logger ?? NOOP_LOGGER;
  const fetchImpl = cfg.fetch ?? globalThis.fetch.bind(globalThis);

  // Resolve the bootstrap credential (ADR-057): explicit credential wins;
  // else a static apiKey; else auto-detect an ambient workload identity.
  const credential: CredentialSource = cfg.credential
    ?? (cfg.apiKey
      ? staticApiKey(cfg.apiKey)
      : autoDetectCredential(DEFAULT_FEDERATION_AUDIENCE, fetchImpl));

  const platformTokens = new PlatformTokenManager({
    credential,
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
    signingKeys: new SigningKeysClient(http, cfg.realmId),
    identityProviderConfig: new IdentityProviderConfigClient(http, cfg.realmId),
    identityProviders: new IdentityProvidersClient(http, cfg.realmId),
    origins: new OriginsClient(http, platformTokens),
    tokens: new TokensClient(cfg.clock ? () => (cfg.clock as () => Date)().getTime() : undefined),
    admin: new AdminClient(http),
    auditEvents: new AuditEventsClient(http, cfg.realmId),
    otp: new OtpClient(http),
    serviceAccounts: new ServiceAccountsClient(http),
    sources: new SourcesClient(http, cfg.realmId),
    info: () => info.get(),
    verify: (token, opts) => verifier.verify(token, opts),
    middleware: (mwCfg) => createMiddleware(handle, mwCfg),
  };
  return handle;
}

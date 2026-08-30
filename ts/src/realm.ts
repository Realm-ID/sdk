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
import { UserApiKeysClient } from "./user-api-keys.js";
import { ConfigClient } from "./config.js";
import { StatsClient } from "./stats.js";
import { RolesClient } from "./roles.js";
import { RoleTemplatesClient } from "./role-templates.js";
import { ScopesClient } from "./scopes.js";
import { SigningKeysClient } from "./signing-keys.js";
import { IdentityProviderConfigClient } from "./identity-provider-config.js";
import { IdentityProvidersClient } from "./identity-providers.js";
import { FederationBindingsClient } from "./federation-bindings.js";
import { SessionsClient } from "./sessions.js";
import { MeClient } from "./me.js";
import { OriginsClient } from "./origins.js";
import { TokensClient } from "./tokens.js";
import { AdminClient } from "./admin.js";
import { AuditEventsClient } from "./audit-events.js";
import { OtpClient } from "./otp.js";
import { ServiceAccountsClient } from "./service-accounts.js";
import { SourcesClient } from "./sources.js";
import { IntegrationsClient } from "./integrations.js";
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
  /**
   * ADR-084 end-user API keys (SPEC §6.6). Separate from `apiKeys` by design:
   * an org admin managing members' keys must not thereby gain platform-key
   * power.
   */
  readonly userApiKeys: UserApiKeysClient;
  readonly config: ConfigClient;
  /** Platform KPI rollup (orgs/users/sessions-24h/MFA coverage). */
  readonly stats: StatsClient;
  readonly roles: RolesClient;
  /**
   * RealmID's role VOCABULARY (ADR-101 D1), not one realm's roles.
   * Base-realm-gated — a partner realm gets `role_authoring_retired` on every
   * verb, and the remedy is ADR-097 scopes, not a retry.
   */
  readonly roleTemplates: RoleTemplatesClient;
  /**
   * ADR-097 §F — the realm-wide bulk scope rename. Realm-owner only.
   *
   * Distinct from `roles`: a ROLE name is RealmID's concept, a SCOPE string is
   * yours. RealmID stores one of yours in exactly one place and understands
   * neither.
   */
  readonly scopes: ScopesClient;
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
  /** Cross-realm integrations: source register/mint + target install (ADR-082/083). */
  readonly integrations: IntegrationsClient;
  /** Workload-identity federation trust bindings (ADR-057). */
  readonly federationBindings: FederationBindingsClient;
  /** Owner/admin session-revocation (ADR-080): force-logout a user or a
   *  realm-wide mass logout. Distinct from `auth.revokeAllSessions` (self). */
  readonly sessions: SessionsClient;
  /** The caller's OWN membership self-service (ADR-092 D5): settle the
   *  single-tenant picker, decline an invitation, leave an org. Authorized by
   *  the end user, never by the platform credential alone. */
  readonly me: MeClient;
  readonly tokenDelivery: "cookie" | "body";
  /** Configured RevocationCache, or undefined when not wired. */
  readonly revocation?: RevocationCache;
  info(): Promise<RealmInfo>;
  verify(token: string, opts?: VerifyOptions): Promise<Claims>;
  middleware(cfg?: MiddlewareConfig): ConnectMiddleware;
  /**
   * Returns a DERIVED realm whose every call carries `accessJWT` as
   * `X-User-Token` — the on-behalf-of mode a BFF needs (SPEC §4 verified on-behalf-of; ADR-056).
   * The realm's platform token stays the wire bearer; the user JWT is
   * additive, so the issuer authorizes a *verified* principal rather than
   * trusting a bare user id (which it refuses outright since v0.66.0).
   *
   *   const asUser = realm.withUserToken(req.session.accessToken);
   *   await asUser.tenants.list();
   *
   * Derivation rather than a per-call option is deliberate: it reaches every
   * typed method without changing a single signature, and it keeps a
   * request-scoped identity off the long-lived realm handle. The
   * platform-token cache, verifier and JWKS cache are SHARED with the parent —
   * deriving per request is cheap. The SDK stores nothing: persistence and
   * refresh of the user JWT stay the caller's responsibility.
   */
  withUserToken(accessJWT: string): Realm;
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

  // The whole resource bundle is a function of ONE HttpClient, so
  // `withUserToken` can re-wire it around a derived client without touching a
  // single typed-method signature. Everything expensive — the platform-token
  // manager, the verifier + its JWKS cache, realm-info discovery — is captured
  // above and SHARED by every derived handle.
  const build = (client: HttpClient): Realm => {
    const handle: Realm = {
      realmId: cfg.realmId,
      baseUrl,
      tokenDelivery: cfg.tokenDelivery ?? "cookie",
      revocation: cfg.revocation,
      auth: new AuthClient(client, cfg.realmId, originResolver, cfg.revocation),
      tenants: new TenantsClient(client, cfg.realmId),
      domains: new DomainsClient(client),
      apiKeys: new ApiKeysClient(client, cfg.realmId),
      userApiKeys: new UserApiKeysClient(client),
      config: new ConfigClient(client, cfg.realmId),
      stats: new StatsClient(client, cfg.realmId),
      roles: new RolesClient(client, cfg.realmId),
      roleTemplates: new RoleTemplatesClient(client, cfg.realmId),
      scopes: new ScopesClient(client, cfg.realmId),
      signingKeys: new SigningKeysClient(client, cfg.realmId),
      identityProviderConfig: new IdentityProviderConfigClient(client, cfg.realmId),
      identityProviders: new IdentityProvidersClient(client, cfg.realmId),
      origins: new OriginsClient(client, platformTokens),
      tokens: new TokensClient(cfg.clock ? () => (cfg.clock as () => Date)().getTime() : undefined),
      admin: new AdminClient(client),
      auditEvents: new AuditEventsClient(client, cfg.realmId),
      otp: new OtpClient(client),
      serviceAccounts: new ServiceAccountsClient(client),
      sources: new SourcesClient(client, cfg.realmId),
      integrations: new IntegrationsClient(client, cfg.realmId),
      federationBindings: new FederationBindingsClient(client, cfg.realmId),
      sessions: new SessionsClient(client, cfg.realmId),
      me: new MeClient(client),
      info: () => info.get(),
      verify: (token, opts) => verifier.verify(token, opts),
      middleware: (mwCfg) => createMiddleware(handle, mwCfg),
      withUserToken: (accessJWT: string) => build(client.withUserToken(accessJWT)),
    };
    return handle;
  };

  return build(http);
}

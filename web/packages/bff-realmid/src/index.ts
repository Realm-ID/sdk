/**
 * @realm-id/web-bff-realmid — preset wiring @realm-id/web to the realmid.dev
 * reference BFF (Realm-ID/api, formerly Realm-ID/bff-api).
 *
 * The reference BFF deviates from BFF-SPEC.md in 6 places:
 *
 *   1. Wire shape is snake_case (`session_token`, `expires_at`, …).
 *   2. /login carries a `status: "ok" | "tenants_required"` discriminator.
 *   3. /token is "tokenless rotation": returns only `{ expires_at }` and
 *      keeps the same opaque session bearer (rotated server-side in Redis).
 *   4. /me ships a flat `{user_id, realm_id, tenant_id, role, email,
 *      display_name, expires_at}` shape rather than nested user/tenants.
 *   5. MFA gate is HTTP 412 with `code: mfa_required | mfa_registration_required`
 *      and an `mfa_challenge_token`.
 *   6. Session-limit gate is HTTP 412 with `code: session_limit_reached`
 *      and a `revocation_token` (one-shot bearer for /sessions).
 *
 * Usage:
 *
 *   import { createRealm } from "@realm-id/web";
 *   import { realmidBffPreset } from "@realm-id/web-bff-realmid";
 *
 *   const realm = createRealm({
 *     baseUrl: "https://api.realmid.dev",
 *     ...realmidBffPreset(),
 *   });
 */

import type {
  AdapterContext,
  Endpoints,
  GateRule,
  LoginRequest,
  LoginResponse,
  MeResponse,
  ProvidersResponse,
  RealmConfig,
  RequestAdapters,
  ResponseAdapters,
  TenantRef,
  TokenResponse,
  UserSummary,
} from "@realm-id/web";

interface RealmidLoginUser {
  id?: string;
  email?: string;
  display_name?: string;
}

interface RealmidLoginTenant {
  id?: string;
  role?: string;
  display_name?: string;
  mfa_required?: boolean;
}

interface RealmidLoginBody {
  status?: "ok" | "tenants_required";
  session_token?: string;
  expires_at?: number | string;
  realm_id?: string;
  user?: RealmidLoginUser;
  tenants?: RealmidLoginTenant[];
}

interface RealmidMeMembership {
  tenant_id?: string;
  platform_id?: string;
  display_name?: string;
  role?: string;
}

interface RealmidMeBody {
  user_id?: string;
  realm_id?: string;
  // tenant_id/role name the session's *current* pinned tenant (injected
  // by the BFF from the session record); memberships[] is the full
  // switchable set (issuer GET /me, resolved by contact join).
  tenant_id?: string;
  role?: string;
  email?: string;
  display_name?: string;
  memberships?: RealmidMeMembership[];
  expires_at?: number | string;
}

interface RealmidTokenBody {
  expires_at?: number | string;
}

interface RealmidProviderBody {
  id?: string;
  // Public discovery returns `type`; the admin shape uses `provider`.
  type?: string;
  provider?: string;
  client_type?: string;
  client_id?: string;
  allowed_origins?: string[];
  enabled?: boolean;
  config?: Record<string, string>;
}

interface RealmidProvidersBody {
  providers?: RealmidProviderBody[];
  identity_providers?: RealmidProviderBody[];
  signup_mode?: string;
  allowed_signup_domains?: string[];
}

function mapTenant(t: RealmidLoginTenant): TenantRef {
  return {
    id: t.id ?? "",
    role: t.role ?? "",
    displayName: t.display_name,
    mfaRequired: t.mfa_required,
  };
}

function mapUser(u: RealmidLoginUser): UserSummary {
  return {
    id: u.id ?? "",
    email: u.email,
    displayName: u.display_name,
  };
}

const adaptLogin: NonNullable<ResponseAdapters["login"]> = (raw, _ctx: AdapterContext): LoginResponse => {
  const body = (raw ?? {}) as RealmidLoginBody;

  if (body.status === "tenants_required") {
    return {
      tenantsRequired: true,
      tenants: (body.tenants ?? []).map(mapTenant),
      realmId: body.realm_id,
    };
  }

  const user = body.user ? mapUser(body.user) : undefined;
  const tenants = (body.tenants ?? []).map(mapTenant);
  return {
    accessToken: body.session_token,
    expiresAt: body.expires_at,
    user,
    tenants,
    defaultTenantId: tenants[0]?.id,
    realmId: body.realm_id,
  };
};

const adaptMe: NonNullable<ResponseAdapters["me"]> = (raw, _ctx): MeResponse => {
  const body = (raw ?? {}) as RealmidMeBody;
  const currentTenantId = body.tenant_id;
  // Full switchable set from memberships[]; fall back to the single
  // current tenant for older BFFs that don't surface memberships.
  const fromMemberships = (body.memberships ?? []).map(
    (m): TenantRef => ({
      id: m.tenant_id ?? "",
      role: m.role ?? "",
      displayName: m.display_name,
    }),
  );
  const tenants: TenantRef[] =
    fromMemberships.length > 0
      ? fromMemberships
      : currentTenantId
        ? [{ id: currentTenantId, role: body.role ?? "", displayName: undefined }]
        : [];
  return {
    user: {
      id: body.user_id ?? "",
      email: body.email,
      displayName: body.display_name,
    },
    tenants,
    currentTenantId,
    expiresAt: body.expires_at,
  };
};

const adaptToken: NonNullable<ResponseAdapters["token"]> = (raw, _ctx): TokenResponse => {
  const body = (raw ?? {}) as RealmidTokenBody;
  // Tokenless rotation: bearer is unchanged; only expiry advances.
  return { expiresAt: body.expires_at };
};

const adaptProviders: NonNullable<ResponseAdapters["providers"]> = (raw, _ctx): ProvidersResponse => {
  const body = (raw ?? {}) as RealmidProvidersBody;
  const list = body.providers ?? body.identity_providers ?? [];
  return {
    providers: list.map((p) => ({
      id: p.id ?? "",
      // Public discovery uses `type`; fall back to the admin `provider`.
      provider: p.type ?? p.provider ?? "",
      clientType: (p.client_type ?? "web") as ProvidersResponse["providers"][number]["clientType"],
      clientId: p.client_id,
      allowedOrigins: p.allowed_origins,
      enabled: p.enabled ?? true,
      config: p.config,
    })),
    signupMode: body.signup_mode as ProvidersResponse["signupMode"],
    allowedSignupDomains: body.allowed_signup_domains,
  };
};

export const realmidBffAdapters: ResponseAdapters = {
  login: adaptLogin,
  me: adaptMe,
  token: adaptToken,
  providers: adaptProviders,
};

/**
 * Request-shape adapters. The reference BFF expects:
 *
 *   POST /login          { method, token, tenant_id?, realm_id? }
 *   POST /token          (no body — bearer-only)
 *   POST /auth/mfa/verify { mfa_challenge_token, code, method? }
 *
 * The SDK speaks `{ method, providerToken, tenantId, ... }` (camelCase),
 * `{ tenantId }` for /token, and `{ challengeId/Token, code, method }`
 * for /mfa/verify. These adapters translate.
 */
export const realmidBffRequestAdapters: RequestAdapters = {
  login: (canonical: LoginRequest) => {
    const body: Record<string, unknown> = {};
    // The web SDK speaks the BFF's OWN /login contract: { method, token,
    // tenant_id } (see api/internal/handlers/handlers.go — it requires
    // `method` + `token`). This `method` is NOT the ADR-051-deprecated issuer
    // field: the BFF is a typed translation layer, and the deprecated `method`
    // → grant_type migration lives on the BFF→issuer hop (the Go SDK), not
    // here. Sending grant_type to the BFF fails its `method and token are
    // required` check (regression 2026-07-05). Keep sending `method`.
    if (canonical.method && canonical.method !== "tenant-pin") body.method = canonical.method;
    if (canonical.providerToken) body.token = canonical.providerToken;
    if (canonical.tenantId) body.tenant_id = canonical.tenantId;
    const realmId = (canonical as unknown as { realmId?: unknown }).realmId;
    if (typeof realmId === "string") {
      body.realm_id = realmId;
    }
    if (canonical.email) body.email = canonical.email;
    if (canonical.password) body.password = canonical.password;
    if (canonical.otpCode) body.otp_code = canonical.otpCode;
    return body;
  },
  // /token is bearer-only on the reference BFF; send no body.
  token: () => undefined,
  // /switch-tenant: the SDK speaks { tenantId }, the BFF expects
  // { tenant_id }. The BFF re-pins the session server-side via the
  // user-scoped refresh and returns { expires_at } (session_token
  // unchanged), so the response flows through adaptToken.
  switchTenant: ({ tenantId }) => ({ tenant_id: tenantId }),
  mfaVerify: (canonical) => {
    const body: Record<string, unknown> = { code: canonical.code };
    if (canonical.challengeToken) body.mfa_challenge_token = canonical.challengeToken;
    if (canonical.method) body.method = canonical.method;
    return body;
  },
};

/** Default gates the reference BFF emits. Partners can extend or override per-realm. */
export const realmidBffGates: GateRule[] = [
  {
    status: 412,
    code: "mfa_required",
    gate: "mfa_required",
    extract: (body) => extractMfa(body),
  },
  {
    status: 412,
    code: "mfa_registration_required",
    gate: "mfa_registration_required",
    extract: (body) => extractMfa(body),
  },
  {
    status: 412,
    code: "session_limit_reached",
    gate: "session_limit_reached",
    extract: (body) => {
      const b = (body ?? {}) as Record<string, unknown>;
      const inner = (b.error ?? b) as Record<string, unknown>;
      return {
        revocationToken: inner.revocation_token,
        sessions: inner.sessions,
      };
    },
  },
];

function extractMfa(body: unknown): Record<string, unknown> {
  const b = (body ?? {}) as Record<string, unknown>;
  const inner = (b.error ?? b) as Record<string, unknown>;
  return {
    challengeToken: inner.mfa_challenge_token,
    tenantId: inner.tenant_id,
    method: inner.method ?? "totp",
    // mfa_registration_required carries the pending-MFA session token
    // (ADR-061): the BFF persisted a session sealing the refresh, and the
    // SPA bears this token on POST /auth/mfa/enroll to self-enroll.
    sessionToken: inner.session_token,
  };
}

/**
 * Endpoints for the reference BFF. `switchTenant` re-pins the session
 * server-side using the user-scoped refresh token (no re-login, no
 * provider id_token needed); the SDK uses the mint path in
 * Realm.switchTenant.
 */
export const realmidBffEndpoints: Partial<Endpoints> = {
  providers: "/identity-providers",
  login: "/login",
  token: "/token",
  switchTenant: "/switch-tenant",
  mfaVerify: "/auth/mfa/verify",
  logout: "/logout",
  me: "/me",
};

export interface RealmidBffPresetOptions {
  /** Override individual endpoints if your BFF mounts under a different prefix. */
  endpoints?: Partial<Endpoints>;
}

/**
 * Returns a partial RealmConfig you can spread into createRealm. Bundles
 * adapters, gates, endpoints, and the refresh flags the reference BFF needs.
 */
export function realmidBffPreset(opts: RealmidBffPresetOptions = {}): Partial<RealmConfig> {
  return {
    adapters: realmidBffAdapters,
    requestAdapters: realmidBffRequestAdapters,
    gates: realmidBffGates,
    endpoints: { ...realmidBffEndpoints, ...(opts.endpoints ?? {}) },
    refresh: { tokenless: true, sendBearer: true },
    clientTypeQueryParam: "platform",
  };
}

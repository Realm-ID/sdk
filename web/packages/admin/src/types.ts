/**
 * Shared wire types for the admin SDK. Shapes mirror `ui/web/src/api.ts`
 * and the BFF's response envelopes — see `api/README.md` (formerly `bff-api/`) for the
 * canonical contract.
 */

export type SignupMode = "closed" | "allowlist" | "open";

export interface UserSummary {
  id: string;
  email?: string;
  phone?: string;
  display_name: string;
  role: string;
  status: string;
}

export interface TenantSummary {
  id: string;
  realm_id: string;
  display_name: string;
  allowed_domains: string[];
  custom_domain?: string;
  status: string;
  config: { mfa_policy?: string; signup_mode?: SignupMode };
  owner?: UserSummary | null;
}

export interface InvitationSummary {
  id: string;
  identifier: string;
  role: string;
  status: string;
  expires_at: number;
}

export interface DomainClaimResponse {
  domain: string;
  dns_record_name: string;
  dns_record_value: string;
  status: string;
}

export interface PlatformCreatedResponse {
  platform_id: string;
  admin_tenant_id: string;
  domain: string;
}

export interface Platform {
  id: string;
  domain: string;
  admin_tenant_id: string;
  display_name: string;
}

export interface CreateApiKeyResponse {
  id: string;
  value: string;
  scope: string;
  label?: string;
}

// ---- API keys (issuer `/platforms/{id}/api-keys`, SPEC §6.5) ----

/** Body for `apiKeys.create`. `scope` is the key's bound role. */
export interface ApiKeyCreateInput {
  scope: string;
  label?: string;
}

/**
 * Response from `apiKeys.create`. Carries the one-time `value` (raw
 * secret) — shown only on creation, never returned by `list`.
 */
export interface ApiKeyCreated {
  id: string;
  value: string;
  scope: string;
  label?: string;
}

/**
 * A row from `apiKeys.list`. Mirrors the issuer's `APIKeyListItem`
 * exactly — note there is **no** `label`, and the bound role surfaces
 * as `role` (not the `scope` it was created with). Timestamps are unix
 * seconds; `last_used_at` / `revoked_at` are nullable. A non-null
 * `revoked_at` means the key is revoked.
 */
export interface ApiKeyListItem {
  id: string;
  prefix: string;
  role: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

export interface ApiKeyListPage {
  items: ApiKeyListItem[];
  next_cursor?: string | null;
  total?: number;
}

export interface ActiveSession {
  id: string;
  origin?: string;
  created_at: number;
  last_seen_at?: number;
}

export interface PlatformNote {
  id: string;
  platform_id: string;
  author_user_id: string;
  body: string;
  created_at: number;
}

export interface RotateSigningKeyResponse {
  kid: string;
  retired_kids: string[];
}

export interface SuspendPlatformResponse {
  id: string;
  status: string;
  suspended_at?: number;
  reason?: string;
}

// ---- BFF aggregates ----

export interface BffSectionError {
  code: string;
  message: string;
  status: number;
}

export interface BffSection<T> {
  data?: T;
  error?: BffSectionError;
}

export interface AdminStats {
  // Loose shape — the BFF emits a free-form stats blob; UI shows it raw.
  [k: string]: unknown;
}

export interface AdminPlatformsResponse {
  items: Platform[];
  next_cursor?: string | null;
  total?: number;
}

export interface AuditEvent {
  [k: string]: unknown;
}

export interface AdminEventsResponse {
  items: AuditEvent[];
  next_cursor?: string | null;
}

export interface HomeResponse {
  mode: "ops" | "customer";
  stats?: BffSection<AdminStats>;
  platforms: BffSection<AdminPlatformsResponse>;
  events?: BffSection<AdminEventsResponse>;
}

export interface TenantFullResponse {
  tenant: BffSection<TenantSummary>;
  events: BffSection<AdminEventsResponse>;
}

// ---- /me + identity providers ----

export interface MeMembership {
  tenant_id: string;
  platform_id: string;
  display_name: string;
  role: string;
}

export interface ProfileResponse {
  user_id: string;
  name: string;
  email: string;
  is_realm_staff: boolean;
  owned_platforms_count: number;
  memberships: MeMembership[];
}

export interface PublicIdentityProvider {
  type: string;
  client_id?: string;
  nickname?: string;
}

export interface PublicIdentityProviderResponse {
  tenant_id?: string | null;
  providers: PublicIdentityProvider[];
}

// ---- admin identity-provider CRUD (issuer `/identity-providers`, ADR-046) ----
//
// Distinct from the public lookup above: these carry the full admin row
// (ids, scope, enabled flag, origins) and are owner/realm-admin gated.
// No `client_secret` exists anywhere — RealmID stores only the public
// OAuth `client_id` by design.

export type IdpScope = "realm" | "tenant";
export type IdpClientType = "web" | "ios" | "android" | "desktop" | "other";

export interface AdminIdentityProvider {
  id: string;
  /** "realm" → platform-wide; "tenant" → a per-tenant override. */
  entity_type: IdpScope;
  /** The realm id (when realm-scoped) or tenant id (when tenant-scoped). */
  entity_id: string;
  /** Provider key. Only "google" verifies logins today (ADR-046). */
  provider: string;
  client_type: IdpClientType;
  client_id: string;
  allowed_origins: string[];
  comments: string;
  /** Provider-specific PUBLIC config (firebase web config); empty otherwise. */
  config?: Record<string, string>;
  enabled: boolean;
  created_at: number;
  updated_at: number;
}

export interface IdpCreateInput {
  /** Owning realm/platform id. Required by the issuer on every create. */
  platform_id: string;
  /** Present → tenant-scoped override; omit → realm-scoped (platform-wide). */
  tenant_id?: string;
  provider: string;
  client_type: IdpClientType;
  client_id: string;
  /** Required for `web` client_type; rejected for non-web. */
  allowed_origins?: string[];
  comments?: string;
  /** Provider-specific PUBLIC config — for firebase: apiKey/authDomain/appId. */
  config?: Record<string, string>;
}

/** Sparse update — only these fields are patchable on the issuer. */
export interface IdpPatchInput {
  enabled?: boolean;
  client_id?: string;
  allowed_origins?: string[];
  comments?: string;
  config?: Record<string, string>;
}

export interface IdpListPage {
  items: AdminIdentityProvider[];
}

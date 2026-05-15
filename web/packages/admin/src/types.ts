/**
 * Shared wire types for the admin SDK. Shapes mirror `ui/web/src/api.ts`
 * and the BFF's response envelopes — see `bff-api/README.md` for the
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

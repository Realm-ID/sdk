/**
 * End-user API keys — SPEC §6.6 (ADR-084). `realm.userApiKeys.*`
 *
 * DISTINCT from `realm.apiKeys.*` (§6.5) in every respect: separate table,
 * separate route segment (`user-api-keys`), separate plaintext prefix
 * (`uk_live_` vs `rk_live_`), and a separate permission pair
 * (`user_api_keys:read|manage`). An org admin managing members' keys must not
 * thereby gain platform-key power, and a leaked string should be classifiable at
 * a glance.
 *
 * Wire shapes are issuer-authoritative ("code wins"); field names are snake_case
 * on the wire, matching the rest of this SDK's DTOs.
 */

import type { HttpClient } from "./http.js";
import { RealmError } from "./errors.js";
import type { Claims } from "./claims.js";

/** Org-scope modes (ADR-084 §6). */
export type OrgScope = "selected" | "all";

/**
 * The write payload, shared by {@link UserApiKeysClient.create} and
 * {@link UserApiKeysClient.update} (ADR-100 D12).
 *
 * ⚠️ **PUT RESETS WHAT IT OMITS.** `update` replaces the whole key, so a caller
 * that wants to change only the cap must READ THE KEY FIRST and send `label`,
 * `org_scope` and `org_ids` back unchanged. Send just the cap and the label is
 * blanked and the org scope reset to the realm default. This is the price of
 * one write schema instead of two, and it is deliberate: PATCH would make
 * `permissions_cap` and `uncapped` an order-dependent pair that can arrive
 * half-specified.
 */
export interface UserApiKeyWrite {
  label: string;
  /**
   * Defaults to the realm's `user_api_keys.org_scope_default`.
   *
   * `"selected"` pins the key to a FROZEN allowlist — orgs the user joins later
   * do NOT widen it. `"all"` is FORWARD-INCLUSIVE and requires the realm's
   * `user_api_keys.allow_all_orgs`, because it is the one mode that widens with
   * no human in the loop.
   */
  org_scope?: OrgScope;
  /**
   * Defaults to just the user's current org. Every entry must be a live
   * membership of the target user, else `400 org_not_a_membership`.
   */
  org_ids?: string[];
  /**
   * **REQUIRED — a key's authority is stated, never inferred (ADR-100).**
   *
   * `true` means *all current AND FUTURE permissions of the holder*, and needs
   * the realm's `user_api_keys.allow_uncapped` (`403 uncapped_not_allowed`
   * otherwise). `false` requires a non-empty `permissions_cap`.
   *
   * There is no third state and no default. Omitting this field is `400`, and
   * that is the whole point of the field existing: before ADR-100 an absent
   * `permissions_cap` produced a key carrying the holder's full authority, so
   * ticking nothing in a console granted everything. An operator who wants
   * TODAY's permission set frozen selects today's permissions explicitly —
   * `uncapped: true` is not a shorthand for it.
   */
  uncapped: boolean;
  /**
   * A CAP, never a grant — see {@link capAllows}. For the `realmid` audience
   * these are validated against RealmID's ADR-074 catalog at mint
   * (`400 unknown_permission`); for a partner audience they are opaque to
   * RealmID and shape-validated only.
   *
   * Must be non-empty when `uncapped` is `false`, and must be empty or omitted
   * when `uncapped` is `true` — the two together are self-contradicting and are
   * refused (`400`). `{}` is not a storable state (ADR-100 D1).
   */
  permissions_cap?: string[];
  /**
   * Omitted = the realm default. Above the realm ceiling returns
   * `400 ttl_exceeds_max`. `0` requests a non-expiring key, which needs
   * `user_api_keys.allow_non_expiring`.
   *
   * Mutable on `update` (ADR-100 D13) and recorded in the audit log when it
   * changes.
   */
  ttl_seconds?: number;
}

/** The create half of {@link UserApiKeyWrite}. Same schema; one shape. */
export type UserApiKeyCreate = UserApiKeyWrite;

/**
 * One key entry. A union of the create-response and list-row wire shapes:
 *
 *   - On create: `id`, `value` (the one-time secret), `label`, `org_scope`,
 *     `org_ids`, `permissions_cap`, `expires_at`.
 *   - On list:   the above minus `value`, plus `prefix`, `minted_mfa_at`,
 *     `created_at`, `last_used_at`, `revoked_at`.
 */
export interface UserApiKey {
  id: string;
  /** Raw secret — returned ONLY on create (one-time reveal). Prefix `uk_live_`. */
  value?: string;
  /**
   * Non-secret hash prefix (list rows). With `label` it is the ONLY handle on a
   * key: the plaintext is never returned again, so a found `uk_live_…` cannot
   * otherwise be correlated to its row.
   */
  prefix?: string;
  label?: string;
  org_scope?: OrgScope;
  /**
   * The scope AS STORED. An org named here may no longer be reachable:
   * revocation on membership loss is an async sweep and live membership is
   * re-intersected at every exchange, so a key can LIST an org it can no longer
   * MINT into. Showing the stored value is the honest answer.
   */
  org_ids?: string[];
  /**
   * `true` when the key carries the holder's full authority. Mutually exclusive
   * with a non-empty `permissions_cap`: exactly one of the two describes the
   * key (ADR-100 D2).
   */
  uncapped?: boolean;
  /**
   * See {@link capAllows} — do NOT test membership of this array on its own.
   * Absent or empty when `uncapped` is `true`; otherwise non-empty. The server
   * cannot store `{}`.
   */
  permissions_cap?: string[];
  /**
   * Unix seconds MFA was proven at mint; null = not proven. Load-bearing, not
   * informational: key exchange is exempt from the realm MFA floor if and only
   * if this is set.
   */
  minted_mfa_at?: number | null;
  created_at?: number;
  last_used_at?: number | null;
  /** Unix seconds; null = non-expiring. */
  expires_at?: number | null;
  /** Unix seconds; non-null means revoked. */
  revoked_at?: number | null;
}

export class UserApiKeysClient {
  constructor(private readonly http: HttpClient) {}

  /**
   * Mint a key for `userId`, which MUST be the caller — keys are self-service,
   * with no override: an admin minting a credential that authenticates AS a
   * member is impersonation by another name, and ADR-039 is deliberately
   * unbuilt.
   *
   * ADR-091 removed the `user_api_keys.admin_mint_allowed` escape hatch
   * entirely. It is no longer a config key; PATCHing it answers
   * `400 unknown_config_key`.
   *
   * The returned `value` is shown ONCE. Persist it at the call site or it is
   * gone.
   */
  async create(tenantId: string, userId: string, body: UserApiKeyWrite): Promise<UserApiKey> {
    return this.http.request<UserApiKey>({
      method: "POST",
      path: userApiKeysPath(tenantId, userId),
      body: writeBody(body),
    });
  }

  /**
   * Replace a key in place (ADR-100 D12) — cap, label, org scope and TTL.
   * The key's SECRET is untouched: `update` never re-issues plaintext and the
   * response carries no `value`.
   *
   * ⚠️ **This is a PUT: it resets what it omits.** Read the key, change the one
   * field, send the whole shape back. See {@link UserApiKeyWrite}.
   *
   * Widening — `uncapped: false → true`, adding permissions, `org_scope:
   * "selected" → "all"`, extending the TTL — is gated by the same MFA step-up
   * as the mint (`user_api_keys.require_mfa_at_mint`). It has to be: a key
   * minted narrowly and then widened through an unguarded update would make the
   * mint's gate decorative.
   *
   * A cap change takes effect at the NEXT token mint. Access tokens already
   * issued keep the bound they were minted with until they expire.
   */
  async update(
    tenantId: string,
    userId: string,
    id: string,
    body: UserApiKeyWrite,
  ): Promise<UserApiKey> {
    return this.http.request<UserApiKey>({
      method: "PUT",
      path: `${userApiKeysPath(tenantId, userId)}/${encodeURIComponent(id)}`,
      body: writeBody(body),
    });
  }

  /**
   * List every key for `userId`, INCLUDING revoked and expired ones — the
   * surface shows them and callers filter as needed. Never returns plaintext.
   */
  async list(tenantId: string, userId: string): Promise<UserApiKey[]> {
    const raw = await this.http.request<unknown>({
      method: "GET",
      path: userApiKeysPath(tenantId, userId),
    });
    return decodeUserApiKeyList(raw);
  }

  /** Soft revoke. Idempotent. */
  async revoke(tenantId: string, userId: string, id: string): Promise<void> {
    await this.http.request({
      method: "DELETE",
      path: `${userApiKeysPath(tenantId, userId)}/${encodeURIComponent(id)}`,
    });
  }
}

/**
 * The one place the write shape is serialised, so create and update cannot
 * drift apart.
 *
 * `uncapped` is spread UNCONDITIONALLY, not `...(x !== undefined ? …)` like its
 * neighbours. An omitted `uncapped` is exactly the wire shape ADR-100 exists to
 * make illegal, so letting it fall out of an `undefined` guard would rebuild the
 * bug in the SDK. `!!` rather than a pass-through so a caller in plain JS
 * cannot smuggle `null` through and land back on "absent".
 */
function writeBody(body: UserApiKeyWrite): Record<string, unknown> {
  return {
    label: body.label,
    uncapped: !!body.uncapped,
    ...(body.org_scope !== undefined ? { org_scope: body.org_scope } : {}),
    ...(body.org_ids !== undefined ? { org_ids: body.org_ids } : {}),
    ...(body.permissions_cap !== undefined ? { permissions_cap: body.permissions_cap } : {}),
    ...(body.ttl_seconds !== undefined ? { ttl_seconds: body.ttl_seconds } : {}),
  };
}

function userApiKeysPath(tenantId: string, userId: string): string {
  return `/tenants/${encodeURIComponent(tenantId)}/users/${encodeURIComponent(userId)}/user-api-keys`;
}

/** Reports whether a key has been soft-revoked. */
export function isUserApiKeyRevoked(k: UserApiKey): boolean {
  return k.revoked_at != null;
}

/**
 * Returns the permissions a principal holds RIGHT NOW, from the caller's own
 * store. The second operand of the cap intersection.
 */
export type LivePermissionResolver = () => Promise<string[]> | string[];

/**
 * Reports whether `permission` is allowed for a key-derived token.
 *
 * Effective authority is `permissions_cap ∩ live permissions`, so BOTH operands
 * must say yes. **`resolveLive` is a required parameter, not an option**, and
 * that is the entire design of this signature: the insecure one-operand form —
 * "does the cap list this permission?" — is not expressible through this API, so
 * a partner cannot implement the stale-scope semantics ADR-084 rejected by
 * accident.
 *
 * Fails CLOSED — returns false when the cap omits the permission, when the live
 * set omits it, or when the resolver throws. An unavailable live operand means
 * the intersection is unknown, and the only safe reading of an unknown
 * intersection is empty.
 *
 * An ABSENT `permissions_cap` claim means the token is not key-derived, or is
 * derived from an UNCAPPED key (ADR-100 D7 — uncapped is still delivered by
 * omission); only the live set governs. A PRESENT-but-empty cap means "capped
 * to nothing" and denies everything.
 *
 * ⚠️ **Since ADR-100 the issuer never EMITS `[]`** — an empty intersection is a
 * `403` at mint rather than an empty claim, and `{}` is not a storable cap. The
 * present-but-empty branch below is kept anyway, and must not be tidied away:
 * it is what a garbled or hostile claim arriving off the wire lands on, and the
 * only safe reading of "I am capped, to something unreadable" is "to nothing".
 * We no longer produce the state; we still deny on it. The mirror of this
 * comment is in the issuer's `permcap` package.
 *
 * No pattern matching: RealmID never expands wildcards, applies hierarchy, or
 * implies `*`, and neither does this.
 */
export async function capAllows(
  claims: Claims | null | undefined,
  permission: string,
  resolveLive: LivePermissionResolver,
): Promise<boolean> {
  if (!claims || !permission || typeof resolveLive !== "function") return false;
  const cap = capFromClaims(claims);
  if (cap !== undefined && !cap.includes(permission)) return false;
  let live: string[];
  try {
    live = await resolveLive();
  } catch {
    return false;
  }
  return Array.isArray(live) && live.includes(permission);
}

/**
 * Extracts `permissions_cap`. Returns `undefined` for ABSENT (not a capped
 * token) and an array — possibly empty — when the claim is PRESENT.
 *
 * A present-but-unparseable claim yields `[]`: the token asserts it is capped
 * and we cannot tell to what, so the only safe reading is "capped to nothing".
 */
function capFromClaims(claims: Claims): string[] | undefined {
  const raw = (claims as unknown as Record<string, unknown>)["permissions_cap"];
  if (raw === undefined) return undefined;
  if (Array.isArray(raw)) return raw.filter((v): v is string => typeof v === "string");
  return [];
}

/** Tolerates the issuer `{ items }` envelope or a flat array. */
function decodeUserApiKeyList(raw: unknown): UserApiKey[] {
  if (Array.isArray(raw)) return raw as UserApiKey[];
  if (raw && typeof raw === "object") {
    const env = raw as { items?: UserApiKey[] };
    if (Array.isArray(env.items)) return env.items;
  }
  throw new RealmError({
    code: "server_error",
    message: "user-api-keys list: unexpected response shape",
  });
}

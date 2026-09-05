/**
 * RealmID's role VOCABULARY — ADR-101 D1's write side.
 *
 * Distinct from `roles.ts`, and the distinction is the whole ADR. A ROLE
 * belongs to one realm and has holders; a TEMPLATE is the recipe a role is
 * stamped from, and it belongs to RealmID. Partners cannot reach this surface
 * at all: every route is base-realm-gated (D4) and answers
 * `role_authoring_retired` anywhere else. It lives in the SDK because
 * RealmID's own console is an SDK consumer like any other.
 *
 * D1 moved the vocabulary out of compiled-in Go slices and into a table so that
 * adding a role stops requiring a release. The table landed first and was
 * read-only, which made that true of the schema and not of the workflow — these
 * methods are the workflow.
 */

import type { HttpClient } from "./http.js";
import type { PrincipalKind } from "./roles.js";

/**
 * A template's level. Part of the IDENTITY together with `name`: the same name
 * at both levels is two different roles carrying different authority — a
 * platform `admin` runs a realm, a tenant `admin` runs one org. Collapsing them
 * is the ADR-090 bug class, so this is a closed union rather than `string`.
 */
export const ROLE_TEMPLATE_LEVELS = ["platform", "tenant"] as const;
export type RoleTemplateLevel = (typeof ROLE_TEMPLATE_LEVELS)[number];

/** One row of RealmID's role vocabulary. */
export interface RoleTemplate {
  id: string;
  level: RoleTemplateLevel;
  name: string;
  display_name: string;
  /** ADR-074 catalog grants. Empty is meaningful — `member` is identity with no authority. */
  permissions: string[];
  /** ADR-081 principal kinds. Never empty: an empty set is an unfinished row, not "any". */
  assignable_to: PrincipalKind[];
  is_system: boolean;
  /**
   * `false` means the template is part of the FLOOR every realm receives, and
   * creating it FANS OUT to realms that already exist. `true` means it is
   * created only when named.
   */
  optional: boolean;
  created_at?: number;
  updated_at?: number;
}

export interface RoleTemplateCreate {
  level: RoleTemplateLevel;
  name: string;
  displayName?: string;
  permissions?: string[];
  /** Required and non-empty (ADR-081 § Amendment 2). */
  assignableTo: PrincipalKind[];
  isSystem?: boolean;
  optional?: boolean;
}

/**
 * Every field optional. An OMITTED key preserves the stored value.
 * `level` and `name` are absent by design — they are the identity.
 */
export interface RoleTemplatePatch {
  displayName?: string;
  permissions?: string[];
  assignableTo?: PrincipalKind[];
  isSystem?: boolean;
  optional?: boolean;
}

export interface RoleTemplateCreated {
  role_template: RoleTemplate;
  /**
   * How many realm role rows the fan-out created. This is the difference
   * between "the role exists for realms created from now on" and "the role
   * reached the realms that already exist" — only the second is what ADR-101
   * promises, so read it rather than assuming.
   */
  realms_stamped: number;
}

export interface RoleTemplatePatched {
  role_template: RoleTemplate;
  /**
   * Realms whose stamped role no longer matches this template. An edit does
   * NOT propagate, so this is the drift the edit just created.
   *
   * ⚠️ `-1` means the count COULD NOT BE TAKEN. It never means "none" — treat
   * it as unknown, not as a clean bill of health.
   */
  drifted_realms: number;
}

export interface RoleTemplateDeleted {
  status: string;
  /**
   * Realms still holding a role stamped from the deleted template. The
   * vocabulary row is gone; those roles and their holders are not.
   * `-1` means the count could not be taken.
   */
  realms_still_holding: number;
}

/** `realm.roleTemplates`. */
export class RoleTemplatesClient {
  constructor(
    private readonly http: HttpClient,
    private readonly realmId: string,
  ) {}

  private base(): string {
    return `/platforms/${encodeURIComponent(this.realmId)}/role-templates`;
  }

  /** GET the vocabulary. Omit `level` for both levels. */
  async list(level?: RoleTemplateLevel): Promise<RoleTemplate[]> {
    const raw = await this.http.request<{ role_templates?: RoleTemplate[] | null }>({
      method: "GET",
      path: this.base(),
      query: level ? { level } : undefined,
    });
    // A null list must become [], never propagate as null: an iterating caller
    // crashes on it, and the server's own columns are NOT NULL anyway.
    return raw?.role_templates ?? [];
  }

  /**
   * Add a role to RealmID's vocabulary. A non-optional (floor) template FANS
   * OUT to every realm governed at its level — check `realms_stamped`.
   */
  async create(body: RoleTemplateCreate): Promise<RoleTemplateCreated> {
    const wire: Record<string, unknown> = {
      level: body.level,
      name: body.name,
      // Always sent, never omitted: it is required server-side, and a body that
      // silently drops it is a 400 the caller cannot diagnose from the code.
      assignable_to: body.assignableTo,
    };
    if (body.displayName !== undefined) wire["display_name"] = body.displayName;
    if (body.permissions !== undefined) wire["permissions"] = body.permissions;
    if (body.isSystem !== undefined) wire["is_system"] = body.isSystem;
    if (body.optional !== undefined) wire["optional"] = body.optional;
    return this.http.request<RoleTemplateCreated>({
      method: "POST",
      path: this.base(),
      body: wire,
    });
  }

  /**
   * Patch a template's mutable fields. Changes the RECIPE only — realms already
   * holding a stamped role keep what they were stamped with. Read
   * `drifted_realms` on the result, and remember `-1` is "unknown", not "none".
   *
   * May reject with a `RealmError` carrying (via `error.details.server_code`,
   * the same fallback `role_authoring_retired` uses):
   * - `role_template_seated` (409) — principals are currently seated at this
   *   template; the write was refused. RECOVERABLE: pass
   *   `{ overrideSeated: true }` to retry with `?override_seated=true`
   *   (audited).
   * - `role_template_seat_check_failed` (503) — the seat count could not be
   *   TAKEN at all, so the write was refused ("could not tell" must not read as
   *   "none"). ⚠️ UNCONDITIONAL — `overrideSeated` does NOT rescue this one;
   *   there is no count to override, only an inability to compute one. Do not
   *   build a retry loop around it.
   */
  async update(
    templateId: string,
    patch: RoleTemplatePatch,
    opts?: { overrideSeated?: boolean },
  ): Promise<RoleTemplatePatched> {
    const wire: Record<string, unknown> = {};
    if (patch.displayName !== undefined) wire["display_name"] = patch.displayName;
    if (patch.permissions !== undefined) wire["permissions"] = patch.permissions;
    if (patch.assignableTo !== undefined) wire["assignable_to"] = patch.assignableTo;
    if (patch.isSystem !== undefined) wire["is_system"] = patch.isSystem;
    if (patch.optional !== undefined) wire["optional"] = patch.optional;
    return this.http.request<RoleTemplatePatched>({
      method: "PATCH",
      path: `${this.base()}/${encodeURIComponent(templateId)}`,
      body: wire,
      // Sent only when explicitly true — the issuer accepts override_seated
      // ONLY as exactly "true" (case-insensitive, trimmed) and treats
      // anything else, including an explicit "false", as absent. So there is
      // no meaningful wire value for "explicitly off"; omission IS off.
      query: opts?.overrideSeated ? { override_seated: "true" } : undefined,
    });
  }

  /**
   * Remove a template from the vocabulary. Roles already stamped from it KEEP
   * their rows and their holders — `realms_still_holding` reports the orphans
   * this creates.
   *
   * May reject with the same two codes documented on {@link update}:
   * `role_template_seated` (409, recoverable — pass `{ overrideSeated: true }`)
   * and `role_template_seat_check_failed` (503, unconditional — no option
   * rescues it).
   */
  async delete(
    templateId: string,
    opts?: { overrideSeated?: boolean },
  ): Promise<RoleTemplateDeleted> {
    return this.http.request<RoleTemplateDeleted>({
      method: "DELETE",
      path: `${this.base()}/${encodeURIComponent(templateId)}`,
      query: opts?.overrideSeated ? { override_seated: "true" } : undefined,
    });
  }
}

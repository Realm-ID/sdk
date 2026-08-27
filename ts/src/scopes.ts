/**
 * ADR-097 §F — the realm-wide bulk scope rename.
 *
 * A scope string is YOUR vocabulary. RealmID stores one in exactly one place —
 * `user_api_keys.permissions_cap`, the cap a key's minted `scope` is
 * intersected against — as a plain array element, not a foreign key. This
 * endpoint exists because renaming a value stored that way is the operation you
 * cannot do safely by hand.
 *
 * See {@link ScopesClient.rename} for the properties that make it safe, and
 * SPEC §11 for the claim itself.
 *
 * **There is no `remove`.** ADR-097 §G's bulk removal was deleted by ADR-100
 * D10: retiring a scope needs no server-side write, because it is self-healing.
 * Stop emitting the string in the `role_permissions` list you supply at token
 * mint, map no route to it, and a stale entry in a stored cap never survives an
 * intersection again. Renaming is the operation you cannot do by hand; removing
 * is the one you no longer have to.
 *
 * @module
 */

import type { HttpClient } from "./http.js";

/** Request body for {@link ScopesClient.rename}. */
export interface ScopeRenameRequest {
  /**
   * The scope string to rename.
   *
   * Validated as an RFC 6749 §3.3 scope-token just like {@link to}, and not
   * merely for symmetry: a `from` containing a space could never match a stored
   * scope, because nothing can store one — so accepting it would guarantee a
   * silent zero-row "success" reading as "there was nothing to rename".
   */
  from: string;
  /**
   * Its replacement. RFC 6749 §3.3 scope-token, bounded by the realm's
   * `user_api_keys.max_permission_string_len`. A SPACE here would corrupt every
   * token minted afterwards by splitting one scope into two.
   */
  to: string;
  /**
   * Return the counts a real run would produce and write NOTHING.
   *
   * Not optional in spirit: the rename is **not reversible in general** —
   * where a key held both `from` and `to`, the merge destroys what a reversal
   * would need. Preview first.
   */
  dryRun?: boolean;
}

/** Result of {@link ScopesClient.rename}. Counts are ROWS, not occurrences. */
export interface ScopeRenameResult {
  from: string;
  to: string;
  /**
   * Echoed so a response cannot be mistaken for the other kind when it is read
   * out of a log.
   */
  dry_run: boolean;
  /** `user_api_keys` rows whose `permissions_cap` changed. */
  keys: number;
  /**
   * ALWAYS `0`.
   *
   * ADR-097 §F originally covered `realm_roles.permissions` too. It does not
   * and cannot: that column is validated against RealmID's own ADR-074 catalog
   * on every role write, in every realm, so it holds RealmID's vocabulary
   * rather than yours — and renaming there would rewrite an ENFORCED permission,
   * failing closed and silently.
   *
   * The field is kept so a client written against the originally-documented
   * two-store shape still parses.
   */
  roles: number;
}

/**
 * `POST /platforms/{id}/scopes/rename`. Realm-owner only.
 */
export class ScopesClient {
  constructor(
    private readonly http: HttpClient,
    private readonly realmId: string,
  ) {}

  /**
   * Renames one of your scope strings across the realm, in one transaction.
   *
   * - **Idempotent** — a second run finds nothing named `from`, reports zeroes
   *   and writes nothing.
   * - **Deduped on collision** — a key holding BOTH strings ends with one `to`,
   *   not two. That merge is why the rename is not reversible in general.
   * - **Dry-runnable** — `{ dryRun: true }` returns the counts a real run would
   *   produce, computed by performing the real updates in a transaction that is
   *   then rolled back, so the number you confirm is the number the write
   *   produces.
   * - **Audited** on the write path only (`scope.rename`, carrying actor, both
   *   strings and both counts).
   *
   * Refused with `realmid_audience_immutable` on a `realmid`-audience realm.
   */
  async rename(body: ScopeRenameRequest): Promise<ScopeRenameResult> {
    return this.http.request<ScopeRenameResult>({
      method: "POST",
      path: `/platforms/${encodeURIComponent(this.realmId)}/scopes/rename`,
      query: { dry_run: body.dryRun ? "true" : undefined },
      body: { from: body.from, to: body.to },
    });
  }
}

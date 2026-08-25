/**
 * ADR-097 §F/§G — the realm-wide bulk scope edits.
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
 * {@link ScopesClient.remove} is a SEPARATE operation, not a flag on rename,
 * and the reason is an inversion rather than a degree: emptying a cap does not
 * narrow a key to nothing — an empty `permissions_cap` means NO RESTRICTION —
 * so removing a key's last scope UNCAPS it. Read that method's notes before
 * calling it.
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

/** What {@link ScopesClient.remove} does about keys it would leave uncapped. */
export type ScopeRemoveOnEmpty = "refuse" | "revoke";

/** Request body for {@link ScopesClient.remove}. */
export interface ScopeRemoveRequest {
  /**
   * The scope string to delete from every `permissions_cap` in the realm.
   *
   * Validated as an RFC 6749 §3.3 scope-token even though it is only a search
   * key: a value containing a space could never match a stored scope, so
   * accepting it would guarantee a silent zero-row "success".
   */
  scope: string;
  /**
   * What to do about keys whose cap this would leave EMPTY — which means **NO
   * RESTRICTION**, not "permits nothing".
   *
   * - `"refuse"` (default) — write nothing, throw `scope_removal_would_uncap`
   *   (HTTP 409). The only mode under which this cannot widen authority.
   * - `"revoke"` — remove the scope AND revoke those keys, in one transaction.
   *   Destructive and irreversible, which is why it must be named.
   *
   * An unrecognised value is REJECTED by the server (`invalid_on_empty`) rather
   * than defaulted: a typo silently selecting a behaviour is the shape where
   * you believe you asked for one thing and got the other.
   */
  onEmpty?: ScopeRemoveOnEmpty;
  /**
   * Preview: report what a real run would do and write NOTHING.
   *
   * **This is how you discover the `emptied` list.** A refusing WRITE answers
   * 409, whose envelope carries no payload — so the preview, which always
   * answers 200, is the only surface that can name the affected keys.
   */
  dryRun?: boolean;
}

/** One key a removal would leave with an empty (= unrestricted) cap. */
export interface ScopeRemoveEmptiedKey {
  id: string;
  user_id: string;
  label: string;
}

/** Result of {@link ScopesClient.remove}. */
export interface ScopeRemoveResult {
  scope: string;
  dry_run: boolean;
  /** The mode in force, including when it was defaulted. */
  on_empty: ScopeRemoveOnEmpty;
  /**
   * `applied` | `would_apply` | `refused`.
   *
   * Three states rather than a pair of booleans, because `dry_run: true` with
   * `applied: false` conflates "nothing was written because you asked for a
   * preview" with "nothing was written because it was refused". On a dry run
   * this reports what the WRITE would have done — `refused` here means the real
   * call would throw.
   */
  outcome: "applied" | "would_apply" | "refused";
  /**
   * `user_api_keys` rows whose cap held the scope, INCLUDING revoked and
   * expired ones — the realm's vocabulary is made consistent everywhere it is
   * stored.
   */
  keys: number;
  /** Keys revoked under `onEmpty: "revoke"`; `0` otherwise. */
  revoked: number;
  /**
   * The LIVE keys this would leave uncapped — **rows, not a count**, because
   * this is the outcome you cannot undo afterwards.
   *
   * Revoked and expired keys are excluded: they cannot mint, so they cannot be
   * uncapped in any way that matters. Their caps are still rewritten.
   */
  emptied: ScopeRemoveEmptiedKey[];
}

/**
 * `POST /platforms/{id}/scopes/rename` and `/remove`. Realm-owner only.
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

  /**
   * Removes one of your scope strings from every cap in the realm.
   *
   * **Not a narrowing operation in every case, which is the whole point.** An
   * empty `permissions_cap` means NO RESTRICTION, so a key holding this scope
   * and nothing else does not become powerless when you remove it — it becomes
   * unrestricted, at RealmID's own permission gates and on scopes alike. The
   * server therefore treats such a key as a PRECONDITION FAILURE:
   *
   * 1. Call with `{ dryRun: true }` and read `emptied`. It always answers 200,
   *    so it is the only surface that can hand you that list.
   * 2. Either re-cap those keys, or re-call with `onEmpty: "revoke"`.
   *
   * Otherwise: idempotent, one transaction, audited on the write path
   * (`scope.remove`), and refused with `realmid_audience_immutable` on a
   * `realmid`-audience realm. Neither the removal nor a revocation it performs
   * can be undone.
   *
   * @throws with code `scope_removal_would_uncap` (HTTP 409) when a live key
   * would be emptied and `onEmpty` is `"refuse"`. Nothing is written — not even
   * the keys that were never at risk.
   */
  async remove(body: ScopeRemoveRequest): Promise<ScopeRemoveResult> {
    return this.http.request<ScopeRemoveResult>({
      method: "POST",
      path: `/platforms/${encodeURIComponent(this.realmId)}/scopes/remove`,
      query: { dry_run: body.dryRun ? "true" : undefined },
      body: { scope: body.scope, on_empty: body.onEmpty },
    });
  }
}

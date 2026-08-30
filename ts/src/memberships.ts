/**
 * Membership self-service — ADR-092 D5. The error CODE taxonomy only.
 *
 * Four operations sit on the BFF beside `GET /me`: choose a tenant when the
 * realm restricts a user to one, accept or reject an invitation, and leave an
 * organisation. Their transport belongs in `@realm-id/web`; what lives here is
 * the part that is CONTRACT — the codes.
 *
 * **The codes are contract; the sentences are not.** Every refusal below is
 * actionable and each has a DIFFERENT remedy, so collapsing them into one
 * banner (which is what happens when a client branches on the 409 status
 * instead of the code) tells the user nothing they can act on. The wording
 * belongs to the application: it is product voice, it is localised, and two
 * consoles will legitimately phrase `owner_cannot_leave` differently. Shipping
 * strings here would make that a fork.
 */

/**
 * The refusals the membership self-service routes emit.
 *
 * - `owner_cannot_be_revoked` / `owner_cannot_leave` — the SAME rule
 *   (`tenants.owner_user_id` is NOT NULL) on two routes: giving up the
 *   membership would leave the org with no owner. Answered only by an ADR-076
 *   ownership TRANSFER, never by a retry. The first fires when a tenant-choice
 *   would revoke an owned membership elsewhere; the second on a direct leave.
 * - `single_tenant_not_required` — the realm no longer restricts the user to
 *   one org, so there is nothing to choose. A stale client, not a user error.
 * - `not_invited` — the target is not a PENDING invitation. If the user is
 *   already a member, the operation they want is `leave`.
 * - `not_pending` — the invitation was already answered, revoked or expired.
 * - `already_left` — idempotent replay of a leave.
 * - `invitations_unavailable` — the platform has no invitation surface, so
 *   nobody can be re-invited; removal has to be done by an administrator.
 * - `membership_not_found` — the org is not one of the caller's any more.
 * - `tenant_required` — no tenant was named and none could be inferred.
 */
export type MembershipActionCode =
  | "owner_cannot_be_revoked"
  | "owner_cannot_leave"
  | "single_tenant_not_required"
  | "not_invited"
  | "not_pending"
  | "already_left"
  | "invitations_unavailable"
  | "membership_not_found"
  | "tenant_required";

/**
 * Every {@link MembershipActionCode}, so a client can build an exhaustive
 * message map and have the compiler complain when the taxonomy grows.
 */
export const MEMBERSHIP_ACTION_CODES: readonly MembershipActionCode[] = [
  "owner_cannot_be_revoked",
  "owner_cannot_leave",
  "single_tenant_not_required",
  "not_invited",
  "not_pending",
  "already_left",
  "invitations_unavailable",
  "membership_not_found",
  "tenant_required",
];

/**
 * Narrow a thrown value's `code` to a {@link MembershipActionCode}.
 *
 * Duck-types on `code` rather than testing `instanceof RealmError`: a browser
 * app commonly holds two different `RealmError` classes at once (`@realm-id/sdk`
 * and `@realm-id/web` are separate bundles), so `instanceof` misses one of
 * them. Anything carrying a string `code` is already a typed realm error.
 */
export function isMembershipActionCode(err: unknown): err is { code: MembershipActionCode } {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return (
    typeof code === "string" &&
    (MEMBERSHIP_ACTION_CODES as readonly string[]).includes(code)
  );
}

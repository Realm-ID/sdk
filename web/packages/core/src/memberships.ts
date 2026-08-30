/**
 * Membership self-service — ADR-092 D5.
 *
 * Four TYPED BFF routes sitting beside `GET /me`: choose a tenant when the
 * realm restricts a user to one, accept or reject an invitation, and leave an
 * organisation. They are typed rather than forwarded for two reasons that
 * matter to the client: the BFF maps each upstream code INDIVIDUALLY (a blanket
 * `upstream_error` flattening would render `owner_cannot_leave` and
 * `already_left` as one banner, and their remedies differ), and a session
 * holding no minted user JWT is refused up front as `session_expired` so the
 * app routes to login instead of surfacing an opaque 401.
 *
 * All four resolve the acting user server-side; the tenant id in the path is a
 * TARGET, never an identity claim, so there is nothing here for the client to
 * authorize. They carry the SESSION bearer — do not mark them anonymous, or the
 * BFF answers `401 session_missing` before the issuer is ever called.
 *
 * **The codes are contract; the sentences are not.** `MEMBERSHIP_ACTION_CODES`
 * is duplicated from `@realm-id/sdk` (which owns it) only because this package
 * has zero runtime dependencies — `memberships.test.ts` holds the two lists
 * equal by SET EQUALITY. The user-facing wording belongs to the application: it
 * is product voice, it is localised, and two consoles will legitimately phrase
 * `owner_cannot_leave` differently. Shipping strings here would make that a
 * fork.
 */

import { bffCall, type RealmFetchLike } from "./bff-call.js";

/**
 * The refusals the membership self-service routes emit.
 *
 * - `owner_cannot_be_revoked` / `owner_cannot_leave` — the SAME rule
 *   (`tenants.owner_user_id` is NOT NULL) on two routes: giving up the
 *   membership would leave the org with no owner. Answered only by an ADR-076
 *   ownership TRANSFER, never by a retry.
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
 * Every {@link MembershipActionCode}, so an app can build an exhaustive message
 * map and have the compiler complain when the taxonomy grows.
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

const CODE_SET: ReadonlySet<string> = new Set<string>(MEMBERSHIP_ACTION_CODES);

/**
 * Pull the membership code out of a thrown value, wherever the transport
 * parked it — and there are three places, because a browser app commonly holds
 * more than one client at once:
 *
 *   - `.code` — a transport that maps the server code straight through;
 *   - `.details.server_code` — `@realm-id/sdk` / `@realm-id/web-admin`, which
 *     stash any code their closed `ErrorCode` union does not name;
 *   - `.body` — this package, whose `RealmError.code` is a classification.
 *
 * Returns `null` for anything outside the taxonomy, so a caller never renders a
 * membership remedy for an unrelated failure.
 */
export function membershipActionCode(err: unknown): MembershipActionCode | null {
  for (const c of candidates(err)) {
    if (typeof c === "string" && CODE_SET.has(c)) return c as MembershipActionCode;
  }
  return null;
}

function candidates(err: unknown): unknown[] {
  if (!err || typeof err !== "object") return [];
  const e = err as Record<string, unknown>;
  const out: unknown[] = [e["code"]];
  const details = e["details"] as Record<string, unknown> | undefined;
  if (details && typeof details === "object") out.push(details["server_code"], details["code"]);
  const body = e["body"] as Record<string, unknown> | undefined;
  if (body && typeof body === "object") {
    out.push(body["code"], body["server_code"]);
    const raw = body["raw"] as Record<string, unknown> | undefined;
    if (raw && typeof raw === "object") {
      out.push(raw["code"]);
      const env = raw["error"] as Record<string, unknown> | undefined;
      if (env && typeof env === "object") out.push(env["code"]);
    }
    const inner = body["error"] as Record<string, unknown> | undefined;
    if (inner && typeof inner === "object") out.push(inner["code"]);
  }
  return out;
}

/** Narrow a thrown value to one carrying a {@link MembershipActionCode}. */
export function isMembershipActionCode(err: unknown): boolean {
  return membershipActionCode(err) !== null;
}

export interface TenantChoiceResult {
  tenant_id: string;
  status: "chosen";
  /** How many other active memberships were released (suspended, recoverable). */
  released: number;
}

export interface MembershipActionResult {
  tenant_id: string;
  status: string;
}

export interface MembershipsOptions {
  /** Absolute base URL of the BFF — `Realm` does not expose its own. */
  baseUrl: string;
}

export interface Memberships {
  /**
   * Settle the ADR-092 D5 picker: KEEP `tenantId`, give up the caller's other
   * active memberships in that realm. The unchosen ones are SUSPENDED
   * (recoverable) and their sessions revoked — say so before the click.
   *
   * 409 `owner_cannot_be_revoked` when the caller owns another org in the
   * realm; 409 `single_tenant_not_required` when the realm no longer requires
   * a choice.
   */
  chooseTenant(tenantId: string): Promise<TenantChoiceResult>;
  /**
   * Take up a pending invitation. Needed because a realm on
   * `invitation_acceptance: "explicit"` does not activate an invitation at
   * login — without this an app can only decline. 409 `not_invited` (already a
   * member) / `not_pending` (already answered).
   */
  acceptInvitation(tenantId: string): Promise<MembershipActionResult>;
  /** Decline a pending invitation. 409 `not_invited` / `not_pending`. */
  rejectInvitation(tenantId: string): Promise<MembershipActionResult>;
  /** Leave an org. 409 `owner_cannot_leave` (transfer ownership first) / `already_left`. */
  leave(tenantId: string): Promise<MembershipActionResult>;
}

/** Bind the four membership operations to a realm's authenticated fetch. */
export function createMemberships(realm: RealmFetchLike, opts: MembershipsOptions): Memberships {
  const call = <T>(path: string, body?: unknown) =>
    bffCall<T>(realm, opts.baseUrl, { method: "POST", path, body });
  const seg = (s: string) => encodeURIComponent(s);

  return {
    chooseTenant: (tenantId) =>
      call<TenantChoiceResult>("/me/tenant-choice", { tenant_id: tenantId }),
    acceptInvitation: (tenantId) =>
      call<MembershipActionResult>(`/me/invitations/${seg(tenantId)}/accept`),
    rejectInvitation: (tenantId) =>
      call<MembershipActionResult>(`/me/invitations/${seg(tenantId)}/reject`),
    leave: (tenantId) =>
      call<MembershipActionResult>(`/me/memberships/${seg(tenantId)}/leave`),
  };
}

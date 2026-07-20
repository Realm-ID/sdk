/**
 * ADR-080 Part 2 login error code.
 *
 * `contact_admin_required` (409, flat envelope `{error:"<msg>",
 * code:"contact_admin_required"}`) is returned at login when a *different*
 * provider tries to claim a contact already bound to another identity — the
 * fail-closed new-provider approval gate. The owner clears it with
 * `admin.tenants.users.delinkContact(...)`.
 *
 * The canonical `ErrorCode` union lives in `@realm-id/sdk` (bundled, not owned
 * by this package), and `contact_admin_required` is NOT (yet) a member — so
 * the transport surfaces it as a `RealmError` whose `.code` falls back to
 * `conflict` with the raw server code preserved under
 * `.details.server_code`. This helper hides that detail: branch on
 * `isContactAdminRequired(err)` regardless of which field carries it.
 */

import { RealmError } from "@realm-id/sdk";

/** The ADR-080 login gate server code. */
export const CONTACT_ADMIN_REQUIRED = "contact_admin_required" as const;

/**
 * True when `err` is the ADR-080 `contact_admin_required` login gate —
 * checking both the mapped `.code` (should the bundled union ever adopt it)
 * and the preserved `.details.server_code`.
 */
export function isContactAdminRequired(err: unknown): boolean {
  if (!(err instanceof RealmError)) return false;
  if ((err.code as string) === CONTACT_ADMIN_REQUIRED) return true;
  const sc = (err.details as Record<string, unknown> | undefined)?.["server_code"];
  return sc === CONTACT_ADMIN_REQUIRED;
}

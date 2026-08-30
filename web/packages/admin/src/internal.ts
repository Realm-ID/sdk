/**
 * `@realm-id/web-admin/internal` — RealmID **base-realm staff** surfaces.
 *
 * ⚠️ **Not for partners.** Everything exported here targets issuer routes under
 * `/admin/…`, which are gated on base-realm staff. A partner platform owner —
 * the audience of the main entry point — can only ever receive `403` from them,
 * so shipping them on `@realm-id/web-admin`'s public surface advertised an API
 * nobody outside RealmID can call. That is why they live behind this subpath
 * instead of being deleted: RealmID's own console still needs them.
 *
 * No stability promise: this subpath may change in a patch release.
 *
 * The ADR-048 read-only aggregates (`admin.admin.*`) are a separate, deliberate
 * case — they are in SPEC §7.5 and stay on the main entry point, documented as
 * staff-only.
 *
 * @internal
 */

import type { Realm } from "@realm-id/web";

import { createAdmin, type Admin, type CreateAdminOptions } from "./index.js";
import { realmFetchAsHttpClient } from "./transport.js";
import { PlatformNotesClient } from "./notes.js";

export { PlatformNotesClient } from "./notes.js";
export type { PlatformNote } from "./types.js";

/** The partner surface plus the staff-only additions. */
export interface OpsAdmin extends Admin {
  /** Append-only ops notes on `/admin/platforms/{id}/notes`. Staff only. */
  notes: PlatformNotesClient;
}

/**
 * Build an admin client carrying the staff-only surfaces as well.
 *
 * Identical to {@link createAdmin} in every other respect — same transport,
 * same options — so a console can swap one call and keep everything else.
 */
export function createOpsAdmin(realm: Realm, opts: CreateAdminOptions): OpsAdmin {
  const base = createAdmin(realm, opts);
  const http = realmFetchAsHttpClient(realm, {
    baseUrl: opts.baseUrl,
    apiPrefix: opts.apiPrefix,
  });
  return { ...base, notes: new PlatformNotesClient(http) };
}

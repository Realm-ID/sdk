/**
 * `TenantsClient` with the ADR-080 identity-binding ops installed under its
 * `users` / `driftReviews` sub-clients. Extends the bundled
 * `@realm-id/sdk` `TenantsClient` so every existing method
 * (list/get/create/invitations/contactVerifications/…) is inherited verbatim;
 * only the two ADR-080-extended sub-clients are swapped in.
 *
 * The base declares `users`/`driftReviews` `readonly`, so the swap uses a
 * mutable cast in the constructor. `declare readonly` re-types the fields to
 * the extended classes for consumers without emitting a second field.
 */

import { TenantsClient } from "@realm-id/sdk/internal";
import { AdminUsersClient, AdminDriftReviewsClient } from "./user-binding.js";

type SdkHttp = ConstructorParameters<typeof TenantsClient>[0];

export class AdminTenantsClient extends TenantsClient {
  declare readonly users: AdminUsersClient;
  declare readonly driftReviews: AdminDriftReviewsClient;

  constructor(http: SdkHttp, realmId: string) {
    super(http, realmId);
    const mut = this as unknown as {
      users: AdminUsersClient;
      driftReviews: AdminDriftReviewsClient;
    };
    mut.users = new AdminUsersClient(http);
    mut.driftReviews = new AdminDriftReviewsClient(http);
  }
}

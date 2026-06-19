/**
 * Rich `/me` profile + admin-flavored `/identity-providers` lookup.
 * Distinct from `realm.providers()` in `@realm-id/web`, which returns
 * the slimmer login-page shape.
 */

import type { HttpLike } from "./transport.js";
import type { ProfileResponse, PublicIdentityProviderResponse } from "./types.js";

export class MeClient {
  constructor(private readonly http: HttpLike) {}

  async profile(): Promise<ProfileResponse> {
    return this.http.request<ProfileResponse>({
      method: "GET",
      path: "/me",
    });
  }

  async identityProviders(opts: { platform?: string } = {}): Promise<PublicIdentityProviderResponse> {
    return this.http.request<PublicIdentityProviderResponse>({
      method: "GET",
      path: "/identity-providers",
      query: { platform: opts.platform ?? "web" },
    });
  }
}

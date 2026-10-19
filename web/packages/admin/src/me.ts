/**
 * Rich `/me` profile + admin-flavored `/identity-providers` lookup.
 * Distinct from `realm.providers()` in `@realm-id/web`, which returns
 * the slimmer login-page shape.
 */

import type { HttpLike } from "./transport.js";
import type { ProfileResponse, PublicIdentityProviderResponse } from "./types.js";

/** `me.sendContactProof` result: the channel the provider accepted the code on. */
export interface ContactProofSent {
  delivered: string;
}

/** The proven contact returned by `me.confirmContactProof`. */
export interface ProvenContact {
  id: string;
  kind: string;
  value: string;
  verified: boolean;
  verifiedAt?: string;
}

export class MeClient {
  /**
   * Send a code to one of the caller's OWN phones — `POST /me/contacts/{contactId}/proof`.
   * The send is inline, so the `200 {delivered}` proves the provider accepted it. Errors:
   * `contact_not_found`, `contact_already_verified`, `phone_otp_rate_limited`,
   * `delivery_unavailable` (503, `details.server_code`).
   */
  async sendContactProof(req: { contactId: string; deliveryMode: "sms" | "whatsapp" }): Promise<ContactProofSent> {
    const d = await this.http.request<{ delivered?: unknown }>({
      method: "POST",
      path: `/me/contacts/${encodeURIComponent(req.contactId)}/proof`,
      body: { delivery_mode: req.deliveryMode },
    });
    return { delivered: typeof d?.delivered === "string" ? d.delivered : "" };
  }

  /**
   * Redeem the code — `POST /me/contacts/{contactId}/proof/confirm`. Errors: `invalid_otp`,
   * `otp_expired`, `otp_locked`, `contact_not_found`, `contact_changed` (409; the code is spent).
   */
  async confirmContactProof(req: { contactId: string; code: string }): Promise<ProvenContact> {
    const d = await this.http.request<{
      id?: unknown; kind?: unknown; value?: unknown; verified?: unknown; verified_at?: unknown;
    }>({
      method: "POST",
      path: `/me/contacts/${encodeURIComponent(req.contactId)}/proof/confirm`,
      body: { code: req.code },
    });
    return {
      id: typeof d?.id === "string" ? d.id : req.contactId,
      kind: typeof d?.kind === "string" ? d.kind : "",
      value: typeof d?.value === "string" ? d.value : "",
      verified: d?.verified === true,
      ...(typeof d?.verified_at === "string" ? { verifiedAt: d.verified_at } : {}),
    };
  }

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

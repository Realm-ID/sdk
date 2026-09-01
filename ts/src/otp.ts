/**
 * Partner OTP primitive — `realm.otp.*`
 *
 * See docs/proposals/partner-otp-primitive.md in the auth repo for design.
 *
 * The three calls all require a tenant-scoped user/service identity.
 * Pass `userBearer` to send the user's access JWT directly, or use the
 * SDK's BFF mode by configuring an upstream platform token + relying
 * on server-side X-On-Behalf-Of-User propagation (out of scope for
 * this client — partner backends typically issue user tokens here).
 */

import type { HttpClient } from "./http.js";

/**
 * OTP delivery modes.
 * 
 * The withholding rule is what distinguishes them: `view_bff` returns the
 * plaintext to the CALLER, while `email` and `sms` have RealmID deliver it to
 * the SUBJECT and the caller receives nothing.
 * 
 * ⚠️ For `purpose=login` that rule decides WHO MAY BE AUTHENTICATED (ADR-103
 * D3/D4), not merely how the code travels:
 * 
 * 	view_bff  the PARTNER reads it  -> kind=service subjects ONLY, owner-gated
 * 	sms       the SUBJECT reads it  -> ANY kind
 * 	email     refused — a login code mailed to an address turns mailbox access
 * 	          into account access with no second factor
 * 
 * There is NO FALLBACK between the RI-delivered modes: asking for `sms` and
 * silently receiving mail would substitute the channel the subject controls,
 * which is the whole property. A subject with no address of the requested kind
 * is a 400 and the issue FAILS.
 */
export type OtpDeliveryMode = "view_bff" | "email" | "sms";

/** Returns the plaintext to the authorized caller (ADR-071 §4). The default. */
export const DELIVERY_MODE_VIEW_BFF: OtpDeliveryMode = "view_bff";
/** RealmID emails the code to the subject (ADR-095 D7). Refused for `purpose=login`. */
export const DELIVERY_MODE_EMAIL: OtpDeliveryMode = "email";
/** RealmID texts the code to the subject's phone (ADR-103). Allowed for `purpose=login`, any kind. */
export const DELIVERY_MODE_SMS: OtpDeliveryMode = "sms";

export interface OtpIssueRequest {
  subjectRef: string;
  purpose: string;
  /**
   * How the OTP reaches the end-user (ADR-071 §4). v1 supports `"view_bff"`
   * only (the plaintext value is returned for BFF display). Omitted defers to
   * the issuer default. A `purpose="login"` OTP for a service account requires
   * `view_bff`.
   */
  deliveryMode?: OtpDeliveryMode;
  /** End-user access JWT (Authorization: Bearer). */
  userBearer?: string;
}

export interface OtpIssueResponse {
  id: string;
  value: string;
  expiresAt: string;
  purpose: string;
  subjectRef: string;
}

export interface OtpViewResponse {
  id: string;
  value: string;
  expiresAt: string;
  purpose: string;
  subjectRef: string;
  issuerUserId: string;
}

export interface OtpVerifyRequest {
  subjectRef: string;
  purpose: string;
  presented: string;
  userBearer?: string;
}

export interface OtpVerifyResponse {
  otpId: string;
  issuerUserId: string;
  issuedAt: string;
  subjectRef: string;
  purpose: string;
}

interface RawIssueResp {
  id: string;
  value: string;
  expires_at: string;
  purpose: string;
  subject_ref: string;
}

interface RawViewResp {
  id: string;
  value: string;
  expires_at: string;
  purpose: string;
  subject_ref: string;
  issuer_user_id: string;
}

interface RawVerifyResp {
  otp_id: string;
  issuer_user_id: string;
  issued_at: string;
  subject_ref: string;
  purpose: string;
}

export class OtpClient {
  constructor(private readonly http: HttpClient) {}

  /** POST /auth/otp/issue */
  async issue(req: OtpIssueRequest): Promise<OtpIssueResponse> {
    const body: Record<string, unknown> = {
      subject_ref: req.subjectRef,
      purpose: req.purpose,
    };
    if (req.deliveryMode !== undefined) body["delivery_mode"] = req.deliveryMode;
    const raw = await this.http.request<RawIssueResp>({
      method: "POST",
      path: "/auth/otp/issue",
      bearer: req.userBearer,
      body,
    });
    return {
      id: raw.id,
      value: raw.value,
      expiresAt: raw.expires_at,
      purpose: raw.purpose,
      subjectRef: raw.subject_ref,
    };
  }

  /** GET /auth/otp/{id} — issuer-scoped. Cross-issuer / cross-tenant 404. */
  async view(otpId: string, opts?: { userBearer?: string }): Promise<OtpViewResponse> {
    const raw = await this.http.request<RawViewResp>({
      method: "GET",
      path: "/auth/otp/" + encodeURIComponent(otpId),
      bearer: opts?.userBearer,
    });
    return {
      id: raw.id,
      value: raw.value,
      expiresAt: raw.expires_at,
      purpose: raw.purpose,
      subjectRef: raw.subject_ref,
      issuerUserId: raw.issuer_user_id,
    };
  }

  /** POST /auth/otp/verify */
  async verify(req: OtpVerifyRequest): Promise<OtpVerifyResponse> {
    const raw = await this.http.request<RawVerifyResp>({
      method: "POST",
      path: "/auth/otp/verify",
      bearer: req.userBearer,
      body: {
        subject_ref: req.subjectRef,
        purpose: req.purpose,
        presented: req.presented,
      },
    });
    return {
      otpId: raw.otp_id,
      issuerUserId: raw.issuer_user_id,
      issuedAt: raw.issued_at,
      subjectRef: raw.subject_ref,
      purpose: raw.purpose,
    };
  }
}

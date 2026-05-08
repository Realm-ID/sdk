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

export interface OtpIssueRequest {
  subjectRef: string;
  purpose: string;
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
    const raw = await this.http.request<RawIssueResp>({
      method: "POST",
      path: "/auth/otp/issue",
      bearer: req.userBearer,
      body: { subject_ref: req.subjectRef, purpose: req.purpose },
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

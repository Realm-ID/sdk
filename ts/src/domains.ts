/**
 * Domains — SPEC §6.4. Two-step claim/verify flow against
 * POST /domains/claim and POST /domains/verify.
 */

import type { HttpClient } from "./http.js";

export interface DomainClaim {
  hostname: string;
  claim_token?: string;
  txt_record?: { name: string; value: string };
  status?: string;
  [k: string]: unknown;
}

export interface DomainVerifyResult {
  hostname?: string;
  verified?: boolean;
  status?: string;
  [k: string]: unknown;
}

export class DomainsClient {
  constructor(private readonly http: HttpClient) {}

  async claim(req: { hostname: string }): Promise<DomainClaim> {
    return this.http.request<DomainClaim>({
      method: "POST",
      path: "/domains/claim",
      body: { hostname: req.hostname },
    });
  }

  async verify(req: { claimToken: string }): Promise<DomainVerifyResult> {
    return this.http.request<DomainVerifyResult>({
      method: "POST",
      path: "/domains/verify",
      body: { claim_token: req.claimToken },
    });
  }
}

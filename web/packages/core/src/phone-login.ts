/**
 * Whether a login screen should offer a phone option (ADR-115; SPEC §4.1.4a):
 * `credentialMethods` contains `"otp"` AND `phoneChannels` is present and
 * non-empty. An absent `phoneChannels` (an older issuer) offers nothing, which
 * is the safe direction: there is no channel the SDK can promise.
 */

import type { ProvidersResponse } from "./types.js";

export function offersPhoneLogin(r: ProvidersResponse): boolean {
  const ch = r.phoneChannels;
  if (ch === undefined || ch.length === 0) return false;
  return (r.credentialMethods ?? []).includes("otp");
}

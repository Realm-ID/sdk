/**
 * The typed error of R86 for the device-approval BFF's `403 device_approval_not_allowed` (SPEC §3.1, §15):
 * the partner's CanApprove refused this person. One class, built by the HTTP decoder from the server's
 * code. Test with {@link isDeviceApprovalNotAllowed}.
 */

import { RealmError } from "./errors.js";

export class DeviceApprovalNotAllowedError extends RealmError {
  constructor(opts?: { message?: string; httpStatus?: number; cause?: unknown; details?: Record<string, unknown> }) {
    super({
      code: "device_approval_not_allowed",
      message: opts?.message?.trim() || "You cannot approve this device.",
      httpStatus: opts?.httpStatus,
      cause: opts?.cause,
      details: opts?.details,
    });
    this.name = "DeviceApprovalNotAllowedError";
  }
}

/** True when `err` is, or wraps (via `cause`), a {@link DeviceApprovalNotAllowedError}. Safe on anything. */
export function isDeviceApprovalNotAllowed(err: unknown): boolean {
  let e: unknown = err;
  for (let i = 0; i < 16 && e !== undefined && e !== null; i++) {
    if (e instanceof DeviceApprovalNotAllowedError) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

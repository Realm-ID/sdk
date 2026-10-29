/**
 * Pure split arithmetic for the browser dealer (SPEC §14.14). BigInt only, no server-runtime
 * imports; the RNG is injected so the vector check can drive it. Deliberately NOT re-exported from
 * the entry point and NOT shared with the server-only SDK split module.
 */

/** lambda(n) = lcm(p-1, q-1). */
export function lambdaOf(p: bigint, q: bigint): bigint {
  const p1 = p - 1n;
  const q1 = q - 1n;
  let a = p1;
  let b = q1;
  while (b !== 0n) [a, b] = [b, a % b];
  return (p1 / a) * q1;
}

/**
 * d_partner = (d - dRi) mod lambda(n), with d reduced modulo lambda(n) first. Throws unless
 * 1 <= dRi < lambda(n) and the result is non-zero (neither half alone may sign, R5).
 */
export function splitWithDRi(p: bigint, q: bigint, d: bigint, dRi: bigint): bigint {
  const lam = lambdaOf(p, q);
  if (dRi < 1n || dRi >= lam) throw new RangeError("d_ri out of [1, lambda)");
  const dP = (((d % lam) - dRi) % lam + lam) % lam;
  if (dP === 0n) throw new RangeError("d_partner is zero");
  return dP;
}

/** Uniform in [0, hi) by rejection sampling over `fill` (crypto.getRandomValues). */
export function randomBelow(hi: bigint, fill: (a: Uint8Array) => Uint8Array): bigint {
  const bits = hi.toString(2).length;
  const nbytes = Math.ceil(bits / 8);
  const excess = BigInt(nbytes * 8 - bits);
  for (;;) {
    const buf = fill(new Uint8Array(nbytes));
    let v = 0n;
    for (const b of buf) v = (v << 8n) | BigInt(b);
    v >>= excess;
    if (v < hi) return v;
  }
}

/** One deal: d_ri uniform in [1, lambda), redrawn while either half is zero. */
export function splitExponent(
  p: bigint,
  q: bigint,
  d: bigint,
  fill: (a: Uint8Array) => Uint8Array,
): { dRi: bigint; dP: bigint } {
  const lam = lambdaOf(p, q);
  for (;;) {
    const dRi = 1n + randomBelow(lam - 1n, fill);
    const dP = (((d % lam) - dRi) % lam + lam) % lam;
    if (dP !== 0n) return { dRi, dP };
  }
}

/** Minimal-length unsigned big-endian bytes, base64url without padding (SPEC §14.14 Encodings). */
export function bigToB64u(x: bigint): string {
  let hex = x.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  let bin = "";
  for (let i = 0; i < hex.length; i += 2) bin += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64uToBig(s: string): bigint {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  let hex = "";
  for (let i = 0; i < bin.length; i++) hex += bin.charCodeAt(i).toString(16).padStart(2, "0");
  return BigInt("0x" + (hex || "0"));
}

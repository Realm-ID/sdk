/**
 * Constant-time modular exponentiation for the partner's secret share d_partner (R27).
 *
 * BigInt `**` and square-and-multiply on a BigInt branch on exponent bits and are variable-time, so
 * the secret never reaches them. ctExp is a fixed-window (4-bit) Montgomery exponentiation over
 * 32-bit limbs in Uint32Array: the sequence of operations and memory accesses depends only on the
 * PUBLIC modulus width, and the window table is read by scanning every entry under a mask. JS gives
 * no hard constant-time guarantee (JIT); ctexp.dudect.ts is the empirical check. Ported from
 * sdk/go/ctexp.go. Server-only, reachable from `@realm-id/sdk/split`.
 *
 * The modulus, n0, R mod n and R^2 mod n are PUBLIC, so BigInt is fine for them. The base (public in
 * practice), the secret exponent bytes and the accumulator stay in limb arrays / bytes.
 */

const WINDOW = 4;
const TABLE = 1 << WINDOW;
const TWO32 = 4294967296;

// Result registers of mac(): avoids allocating a pair per multiply.
const HI = new Uint32Array(1);

/** a*b + t + c for 32-bit unsigned inputs; returns the low 32 bits, sets HI to the high 32 bits. */
function mac(a: number, b: number, t: number, c: number): number {
  const aL = a & 0xffff, aH = a >>> 16, bL = b & 0xffff, bH = b >>> 16;
  const ll = aL * bL, lh = aL * bH, hl = aH * bL, hh = aH * bH; // each < 2^32, exact in a double
  const low = ll + ((lh & 0xffff) + (hl & 0xffff)) * 65536 + t + c; // < 2^36, exact
  const lo = low >>> 0;
  HI[0] = hh + (lh >>> 16) + (hl >>> 16) + (low - lo) / TWO32;
  return lo;
}

/** z = a*b*R^-1 mod mod (CIOS), constant-time over the limbs. t is scratch of mod.length+2. z may alias a or b. */
export function ctMontMul(z: Uint32Array, a: Uint32Array, b: Uint32Array, mod: Uint32Array, t: Uint32Array, n0: number): void {
  const n = mod.length;
  t.fill(0);
  for (let i = 0; i < n; i++) {
    let c = 0;
    const bi = b[i]!;
    for (let j = 0; j < n; j++) {
      t[j] = mac(a[j]!, bi, t[j]!, c);
      c = HI[0]!;
    }
    let s = t[n]! + c;
    t[n] = s >>> 0;
    t[n + 1] = (s - t[n]!) / TWO32;

    const m = Math.imul(t[0]!, n0) >>> 0;
    mac(m, mod[0]!, t[0]!, 0);
    c = HI[0]!;
    for (let j = 1; j < n; j++) {
      t[j - 1] = mac(m, mod[j]!, t[j]!, c);
      c = HI[0]!;
    }
    s = t[n]! + c;
    t[n - 1] = s >>> 0;
    t[n] = t[n + 1]! + (s - (s >>> 0)) / TWO32;
  }
  // Conditional subtraction of mod, selected by mask (no branch).
  const d = new Uint32Array(n);
  let borrow = 0;
  for (let j = 0; j < n; j++) {
    const x = t[j]! - mod[j]! - borrow; // in (-2^32-1, 2^32)
    const lo = x >>> 0;
    d[j] = lo;
    borrow = (lo - x) / TWO32; // 1 iff x < 0
  }
  const useD = t[n]! | (borrow ^ 1);
  const mask = -(useD & 1) | 0;
  for (let j = 0; j < n; j++) z[j] = (d[j]! & mask) | (t[j]! & ~mask);
}

function toLimbs(x: bigint, n: number): Uint32Array {
  const out = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = Number(x & 0xffffffffn);
    x >>= 32n;
  }
  return out;
}

function fromLimbs(l: Uint32Array): bigint {
  let r = 0n;
  for (let i = l.length - 1; i >= 0; i--) r = (r << 32n) | BigInt(l[i]!);
  return r;
}

const bitLen = (x: bigint): number => (x === 0n ? 0 : x.toString(2).length);

/** The ladder proper: base (reduced, limbs) ^ exp (big-endian bytes) in Montgomery form; no BigInt. */
function ctExpLimbs(
  base: Uint32Array, exp: Uint8Array, mod: Uint32Array, one: Uint32Array, rr: Uint32Array, n0: number, expBits: number,
): Uint32Array {
  const n = mod.length;
  const t = new Uint32Array(n + 2);
  const bm = new Uint32Array(n);
  ctMontMul(bm, base, rr, mod, t, n0);

  const table: Uint32Array[] = [one, bm];
  for (let i = 2; i < TABLE; i++) {
    const e = new Uint32Array(n);
    ctMontMul(e, table[i - 1]!, bm, mod, t, n0);
    table.push(e);
  }

  const nWin = Math.ceil(expBits / WINDOW);
  const eb = new Uint8Array(Math.ceil((nWin * WINDOW) / 8)); // zero-padded big-endian view of exp
  eb.set(exp, eb.length - exp.length);

  const acc = new Uint32Array(n);
  acc.set(one);
  const sel = new Uint32Array(n);
  for (let w = nWin - 1; w >= 0; w--) {
    for (let s = 0; s < WINDOW; s++) ctMontMul(acc, acc, acc, mod, t, n0);
    const bitPos = w * WINDOW;
    const win = (eb[eb.length - 1 - (bitPos >> 3)]! >>> (bitPos & 7)) & (TABLE - 1);
    sel.fill(0);
    for (let i = 0; i < TABLE; i++) {
      const x = i ^ win;
      const mask = ~((x | -x) >> 31); // all-ones iff i === win, no branch
      const row = table[i]!;
      for (let j = 0; j < n; j++) sel[j] = sel[j]! | (row[j]! & mask);
    }
    ctMontMul(acc, acc, sel, mod, t, n0);
  }
  const unit = new Uint32Array(n);
  unit[0] = 1;
  ctMontMul(acc, acc, unit, mod, t, n0); // leave Montgomery form
  return acc;
}

/**
 * base^exp mod `mod` with no operation or memory access depending on the bits of `exp` (big-endian
 * bytes). `mod` must be odd and > 1. The exponent is padded to max(bitlen(mod), 8*exp.length) bits,
 * so only its byte LENGTH (public: the encoded share) is observable.
 */
export function ctExp(base: bigint, exp: Uint8Array, mod: bigint): bigint {
  if (mod <= 1n || (mod & 1n) === 0n) throw new Error("realmid: modulus must be odd and > 1");
  if (base < 0n) throw new Error("realmid: negative base");
  const modBits = bitLen(mod);
  const n = Math.ceil(modBits / 32);
  const m = toLimbs(mod, n);

  // n0 = -mod^-1 mod 2^32 (Newton; mod is public).
  let inv = m[0]!;
  for (let i = 0; i < 5; i++) inv = Math.imul(inv, (2 - Math.imul(m[0]!, inv)) | 0);
  const n0 = -inv >>> 0;

  const r = 1n << BigInt(32 * n);
  const one = toLimbs(r % mod, n);
  const rr = toLimbs((r * r) % mod, n);
  const b = toLimbs(base % mod, n);
  const expBits = Math.max(modBits, 8 * exp.length);
  return fromLimbs(ctExpLimbs(b, exp, m, one, rr, n0, expBits));
}

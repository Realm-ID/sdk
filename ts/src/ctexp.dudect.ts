/**
 * dudect-style timing check for ctExp (R27). NOT part of `npm test` (the glob is src/*.test.ts):
 *   node --import tsx src/ctexp.dudect.ts        (npm run dudect)
 * Fixed low-weight exponent (3) vs a fresh random exponent, interleaved randomly, per-call ns timing,
 * crops at 50/75/90/97 percentiles plus uncropped, Welch t, limit |t| < 10. A LEAKY BigInt
 * square-and-multiply is measured the same way as a positive control and MUST reach |t| >= 10, else
 * the verdict is vacuous. Run alone: overlapping load voids the result.
 */
import { randomBytes } from "node:crypto";
import { ctExp } from "./ctexp.js";

const BITS = Number(process.env["DUDECT_BITS"] ?? 2048);
const N = Number(process.env["DUDECT_N"] ?? 1500); // per class
const LIMIT = 10;
const WARM = Number(process.env["DUDECT_WARM"] ?? 100);

const toBig = (b: Uint8Array): bigint => BigInt("0x" + Buffer.from(b).toString("hex"));
const modulus = toBig(randomBytes(BITS / 8)) | (1n << BigInt(BITS - 1)) | 1n;
const base = toBig(randomBytes(BITS / 8)) % modulus;
const FIXED = Uint8Array.from([3]);

function nativeExp(b: bigint, e: bigint, m: bigint): bigint {
  let r = 1n;
  let x = b % m;
  for (; e > 0n; e >>= 1n) {
    if (e & 1n) r = (r * x) % m;
    x = (x * x) % m;
  }
  return r;
}

// Correctness vs native BEFORE timing.
for (let i = 0; i < 5; i++) {
  const e = randomBytes(BITS / 8);
  if (ctExp(base, e, modulus) !== nativeExp(base, toBig(e), modulus)) throw new Error("ctExp disagrees with native modPow");
}
if (ctExp(base, FIXED, modulus) !== nativeExp(base, 3n, modulus)) throw new Error("ctExp(3) disagrees with native");

type Fn = (e: Uint8Array) => unknown;

function measure(fn: Fn): { fixed: number[]; random: number[] } {
  for (let i = 0; i < WARM; i++) {
    fn(FIXED);
    fn(randomBytes(BITS / 8));
  }
  const order: boolean[] = [];
  for (let i = 0; i < N; i++) order.push(true, false);
  for (let i = order.length - 1; i > 0; i--) {
    const j = randomBytes(4).readUInt32LE() % (i + 1);
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  const fixed: number[] = [];
  const random: number[] = [];
  for (const isFixed of order) {
    const e = isFixed ? FIXED : new Uint8Array(randomBytes(BITS / 8)); // input prepared outside the timed region
    const t0 = process.hrtime.bigint();
    fn(e);
    const dt = Number(process.hrtime.bigint() - t0);
    (isFixed ? fixed : random).push(dt);
  }
  return { fixed, random };
}

function welch(a: number[], b: number[]): number {
  const mean = (x: number[]): number => x.reduce((s, v) => s + v, 0) / x.length;
  const va = (x: number[], m: number): number => x.reduce((s, v) => s + (v - m) ** 2, 0) / (x.length - 1);
  const ma = mean(a), mb = mean(b);
  const se = Math.sqrt(va(a, ma) / a.length + va(b, mb) / b.length);
  return se === 0 ? 0 : (ma - mb) / se;
}

function maxT(name: string, fn: Fn): number {
  const { fixed, random } = measure(fn);
  const sorted = [...fixed, ...random].sort((x, y) => x - y);
  const crops = [50, 75, 90, 97].map((p) => sorted[Math.floor((sorted.length * p) / 100) - 1]!);
  let worst = Math.abs(welch(fixed, random));
  for (const c of crops) {
    const a = fixed.filter((v) => v <= c), b = random.filter((v) => v <= c);
    if (a.length < 30 || b.length < 30) continue; // a crop that empties a class carries no information
    worst = Math.max(worst, Math.abs(welch(a, b)));
  }
  const mn = (x: number[]): number => x.reduce((s, v) => s + v, 0) / x.length;
  console.log(`  mean ns fixed=${mn(fixed).toFixed(0)} random=${mn(random).toFixed(0)}`);
  console.log(`${name}: max|t| = ${worst.toFixed(2)} (N=${fixed.length}/${random.length} per class, ${BITS}-bit)`);
  return worst;
}

const control = maxT("control (leaky square-and-multiply)", (e) => nativeExp(base, toBig(e), modulus));
const ladder = maxT("ctExp", (e) => ctExp(base, e, modulus));

if (control < LIMIT) {
  console.error(`FAIL: the leaky positive control reached only |t|=${control.toFixed(2)} < ${LIMIT}; the test is vacuous`);
  process.exit(2);
}
if (ladder >= LIMIT) {
  console.error(`FAIL: ctExp max|t|=${ladder.toFixed(2)} >= ${LIMIT}`);
  process.exit(1);
}
console.log(`PASS: control ${control.toFixed(2)} >= ${LIMIT} > ctExp ${ladder.toFixed(2)}`);

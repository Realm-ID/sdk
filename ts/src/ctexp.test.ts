import { test } from "node:test";
import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import { ctExp } from "./ctexp.js";

// R27: ctExp agrees with native BigInt modular exponentiation on PUBLIC operands, 2..2048 bit moduli.

const toBig = (b: Uint8Array): bigint => (b.length === 0 ? 0n : BigInt("0x" + Buffer.from(b).toString("hex")));
const toBytes = (i: bigint): Uint8Array => {
  if (i === 0n) return new Uint8Array(0);
  let h = i.toString(16);
  if (h.length % 2) h = "0" + h;
  return new Uint8Array(Buffer.from(h, "hex"));
};
function native(base: bigint, exp: bigint, mod: bigint): bigint {
  let r = 1n % mod;
  let b = base % mod;
  for (let e = exp; e > 0n; e >>= 1n) {
    if (e & 1n) r = (r * b) % mod;
    b = (b * b) % mod;
  }
  return r;
}
const rnd = (bits: number): bigint => toBig(randomBytes(Math.ceil(bits / 8))) & ((1n << BigInt(bits)) - 1n);
const oddMod = (bits: number): bigint => rnd(bits) | (1n << BigInt(bits - 1)) | 1n;

test("ctExp equals native modPow across modulus sizes (examined count asserted)", () => {
  let n = 0;
  for (const bits of [2, 3, 8, 31, 32, 33, 63, 64, 65, 127, 128, 257, 512, 1024, 2048]) {
    for (let k = 0; k < 4; k++) {
      const mod = bits === 2 ? 3n : oddMod(bits);
      const base = rnd(bits + 8);
      const exp = rnd(bits);
      assert.equal(ctExp(base, toBytes(exp), mod), native(base, exp, mod), `bits=${bits}`);
      n++;
    }
  }
  assert.equal(n, 60);
});

test("ctExp edge cases: exp=0, exp=1, exp>mod, base>mod, base=0, leading-zero exponent bytes", () => {
  const mod = oddMod(256);
  const base = rnd(300);
  assert.equal(ctExp(base, new Uint8Array(0), mod), 1n);
  assert.equal(ctExp(base, Uint8Array.from([0, 0, 0]), mod), 1n);
  assert.equal(ctExp(base, Uint8Array.from([1]), mod), base % mod);
  assert.equal(ctExp(0n, Uint8Array.from([5]), mod), 0n);
  const big = rnd(600);
  assert.equal(ctExp(base, toBytes(big), mod), native(base, big, mod));
  assert.equal(ctExp(base, Uint8Array.from([0, 0, 7]), mod), native(base, 7n, mod));
});

test("ctExp refuses an even or tiny modulus", () => {
  assert.throws(() => ctExp(2n, Uint8Array.from([3]), 10n), /odd/);
  assert.throws(() => ctExp(2n, Uint8Array.from([3]), 1n), /odd/);
  assert.throws(() => ctExp(2n, Uint8Array.from([3]), 0n), /odd/);
});

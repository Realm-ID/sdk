package dev.realmid.sdk.split;

import java.math.BigInteger;
import java.util.Arrays;

/**
 * Constant-time modular exponentiation for the partner's secret share d_partner (R27). Ported from sdk/go/ctexp.go.
 *
 * BigInteger.modPow branches on exponent bits and BigInteger arithmetic is variable-time, so the secret exponent
 * never reaches it. This is a fixed-window (4-bit) Montgomery exponentiation over 32-bit limbs held in long[]
 * (values always < 2^32, so every product fits a 64-bit word): the sequence of operations and memory accesses
 * depends only on the PUBLIC modulus width, and the window table is read by scanning every entry under a mask.
 * The JVM gives no hard constant-time guarantee; the dudect test (gradle task `dudect`) is the empirical check.
 *
 * Only PUBLIC values (modulus, n0, R mod n, R^2 mod n, the base reduction) touch BigInteger, between the
 * PUBLIC-BEGIN / PUBLIC-END markers; the structural guard test scans everything outside them.
 */
final class CtExp {
    private CtExp() {}

    private static final int WINDOW = 4;
    private static final long M32 = 0xFFFFFFFFL;

    // PUBLIC-BEGIN
    private static long[] toLimbs(BigInteger x, int n) {
        byte[] raw = x.toByteArray();
        long[] out = new long[n];
        for (int i = 0; i < n * 4; i++) {
            int idx = raw.length - 1 - i;
            long b = idx >= 0 ? raw[idx] & 0xFFL : 0;
            out[i / 4] |= b << (8 * (i % 4));
        }
        return out;
    }

    private static BigInteger fromLimbs(long[] l) {
        byte[] buf = new byte[l.length * 4];
        for (int i = 0; i < l.length; i++) {
            for (int j = 0; j < 4; j++) buf[buf.length - 1 - 4 * i - j] = (byte) (l[i] >>> (8 * j));
        }
        return new BigInteger(1, buf);
    }

    private static boolean badModulus(BigInteger mod) {
        return mod.signum() <= 0 || !mod.testBit(0) || mod.equals(BigInteger.ONE);
    }

    private static long[][] publicParams(BigInteger base, BigInteger mod, int n) {
        BigInteger r = BigInteger.ONE.shiftLeft(32 * n);
        return new long[][]{toLimbs(mod, n), toLimbs(r.mod(mod), n), toLimbs(r.multiply(r).mod(mod), n),
                toLimbs(base.mod(mod), n)};
    }

    private static int bitLen(BigInteger x) { return x.bitLength(); }
    // PUBLIC-END

    /** z = a*b*R^-1 mod mod (CIOS). t is scratch of n+2 limbs, d of n. z may alias a or b. */
    private static void montMul(long[] z, long[] a, long[] b, long[] mod, long[] t, long[] d, long n0) {
        int n = mod.length;
        Arrays.fill(t, 0);
        for (int i = 0; i < n; i++) {
            long c = 0;
            long bi = b[i];
            for (int j = 0; j < n; j++) {
                long s = t[j] + a[j] * bi + c; // <= 2^64-1, read as unsigned
                t[j] = s & M32;
                c = s >>> 32;
            }
            long s = t[n] + c;
            t[n] = s & M32;
            t[n + 1] = s >>> 32;

            long m = (t[0] * n0) & M32;
            c = (m * mod[0] + t[0]) >>> 32;
            for (int j = 1; j < n; j++) {
                long u = t[j] + m * mod[j] + c;
                t[j - 1] = u & M32;
                c = u >>> 32;
            }
            long u = t[n] + c;
            t[n - 1] = u & M32;
            t[n] = t[n + 1] + (u >>> 32);
        }
        // Conditional subtraction of mod, selected by mask (no branch).
        long borrow = 0;
        for (int j = 0; j < n; j++) {
            long diff = t[j] - mod[j] - borrow;
            d[j] = diff & M32;
            borrow = diff >>> 63;
        }
        long useD = t[n] | (borrow ^ 1);
        long mask = -(useD & 1);
        for (int j = 0; j < n; j++) z[j] = (d[j] & mask) | (t[j] & ~mask);
    }

    /**
     * base^exp mod mod with no operation or memory access depending on the bits of exp. mod is odd and > 1;
     * exp >= 0. The exponent is padded to max(bitlen(mod), bitlen(exp)) bits so its magnitude is not leaked
     * below the modulus width.
     */
    static BigInteger exp(BigInteger base, BigInteger exp, BigInteger mod) {
        if (mod == null || base == null || exp == null) throw new IllegalArgumentException("nil operand");
        if (badModulus(mod)) throw new IllegalArgumentException("modulus must be odd and > 1");
        if (exp.signum() < 0) throw new IllegalArgumentException("negative exponent");
        int n = (bitLen(mod) + 31) / 32;
        long[][] p = publicParams(base, mod, n);
        long[] m = p[0], one = p[1], rr = p[2], b = p[3];

        // n0 = -mod^-1 mod 2^32 (Newton; mod is public).
        int m0 = (int) m[0];
        int inv = m0;
        for (int i = 0; i < 5; i++) inv *= 2 - m0 * inv;
        long n0 = (-inv) & M32;

        long[] t = new long[n + 2];
        long[] d = new long[n];
        long[] bm = new long[n];
        montMul(bm, b, rr, m, t, d, n0);

        long[][] table = new long[1 << WINDOW][];
        table[0] = one;
        table[1] = bm;
        for (int i = 2; i < (1 << WINDOW); i++) {
            table[i] = new long[n];
            montMul(table[i], table[i - 1], bm, m, t, d, n0);
        }

        int expBits = Math.max(bitLen(mod), bitLen(exp));
        int nWin = (expBits + WINDOW - 1) / WINDOW;
        byte[] eb = new byte[(nWin * WINDOW + 7) / 8];
        byte[] raw = exp.toByteArray();
        int copy = Math.min(raw.length, eb.length);
        System.arraycopy(raw, raw.length - copy, eb, eb.length - copy, copy);

        long[] acc = new long[n];
        System.arraycopy(one, 0, acc, 0, n);
        long[] sel = new long[n];
        for (int w = nWin - 1; w >= 0; w--) {
            for (int s = 0; s < WINDOW; s++) montMul(acc, acc, acc, m, t, d, n0);
            int bitPos = w * WINDOW;
            int win = ((eb[eb.length - 1 - bitPos / 8] & 0xFF) >>> (bitPos % 8)) & ((1 << WINDOW) - 1);
            Arrays.fill(sel, 0);
            for (int i = 0; i < (1 << WINDOW); i++) {
                int x = i ^ win;
                long mask = (long) ((x | -x) >>> 31) - 1; // all-ones iff i == win, no branch
                long[] row = table[i];
                for (int j = 0; j < n; j++) sel[j] |= row[j] & mask;
            }
            montMul(acc, acc, sel, m, t, d, n0);
        }
        long[] unit = new long[n];
        unit[0] = 1;
        montMul(acc, acc, unit, m, t, d, n0);
        return fromLimbs(acc);
    }
}

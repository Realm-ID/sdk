package dev.realmid.sdk.split;

import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;

import java.math.BigInteger;
import java.security.SecureRandom;
import java.util.Arrays;

import static org.junit.jupiter.api.Assertions.*;

/**
 * dudect-style timing test of the constant-time ladder (R27); ported from sdk/go ctexp_dudect_test.go.
 * Tagged "dudect": excluded from `gradle test`, run with `./gradlew dudect`.
 * Knobs (env): DUDECT_N measurements per class (default 3000), DUDECT_T |t| limit (default 10).
 *
 * Class A = fixed LOW-weight exponent (3), class B = fresh random exponent, interleaved randomly; per-call ns;
 * crops at 50/75/90/97 percentiles plus uncropped; Welch t; max |t| must stay under the limit. A leaky
 * square-and-multiply positive control must reach |t| >= 10 or the verdict is vacuous. A JIT warm-up precedes
 * every measurement.
 */
@Tag("dudect")
class CtExpDudectTest {
    interface ExpFn { BigInteger apply(BigInteger base, BigInteger exp, BigInteger mod); }

    static final SecureRandom R = new SecureRandom();

    static int env(String name, int def) {
        String s = System.getenv(name);
        if (s != null) try { int n = Integer.parseInt(s); if (n > 0) return n; } catch (NumberFormatException ignored) { }
        return def;
    }

    static double welchT(double[] a, double[] b) {
        double ma = mean(a), mb = mean(b);
        double den = Math.sqrt(var(a, ma) / a.length + var(b, mb) / b.length);
        return den == 0 ? 0 : (ma - mb) / den;
    }

    static double mean(double[] x) { double s = 0; for (double v : x) s += v; return s / x.length; }

    static double var(double[] x, double m) { double s = 0; for (double v : x) s += (v - m) * (v - m); return s / (x.length - 1); }

    static double maxT(double[] fixed, double[] random) {
        double[] all = new double[fixed.length + random.length];
        System.arraycopy(fixed, 0, all, 0, fixed.length);
        System.arraycopy(random, 0, all, fixed.length, random.length);
        Arrays.sort(all);
        double best = Math.abs(welchT(fixed, random));
        for (double p : new double[]{0.5, 0.75, 0.9, 0.97}) {
            double cut = all[(int) (p * (all.length - 1))];
            double[] f = Arrays.stream(fixed).filter(v -> v <= cut).toArray();
            double[] r = Arrays.stream(random).filter(v -> v <= cut).toArray();
            if (f.length > 10 && r.length > 10) best = Math.max(best, Math.abs(welchT(f, r)));
        }
        return best;
    }

    static BigInteger modulus() {
        return new BigInteger(2048, R).setBit(0).setBit(2047);
    }

    static double measure(ExpFn fn, int n) {
        BigInteger mod = modulus();
        BigInteger base = mod.shiftRight(3);
        BigInteger fixedExp = BigInteger.valueOf(3);
        BigInteger sink = BigInteger.ZERO;
        for (int i = 0; i < Math.max(300, n / 5); i++) { // JIT warm-up, both classes
            sink = sink.xor(fn.apply(base, i % 2 == 0 ? fixedExp : randomExp(mod), mod));
        }
        double[] fixed = new double[n], random = new double[n];
        int nf = 0, nr = 0;
        while (nf < n || nr < n) {
            boolean useFixed = R.nextBoolean();
            if (useFixed && nf >= n) useFixed = false;
            else if (!useFixed && nr >= n) useFixed = true;
            BigInteger exp = useFixed ? fixedExp : randomExp(mod);
            long t0 = System.nanoTime();
            BigInteger out = fn.apply(base, exp, mod);
            long d = System.nanoTime() - t0;
            sink = sink.xor(out);
            if (useFixed) fixed[nf++] = d; else random[nr++] = d;
        }
        assertNotNull(sink);
        return maxT(fixed, random);
    }

    static BigInteger randomExp(BigInteger mod) {
        return new BigInteger(mod.subtract(BigInteger.ONE).bitLength(), R).mod(mod.subtract(BigInteger.ONE)).add(BigInteger.ONE);
    }

    /** POSITIVE CONTROL: square-and-multiply that skips the multiply on a zero bit. */
    static BigInteger leaky(BigInteger base, BigInteger exp, BigInteger mod) {
        BigInteger r = BigInteger.ONE;
        for (int i = exp.bitLength() - 1; i >= 0; i--) {
            r = r.multiply(r).mod(mod);
            if (exp.testBit(i)) r = r.multiply(base).mod(mod);
        }
        return r;
    }

    @Test
    void harnessDetectsLeak() {
        double got = measure(CtExpDudectTest::leaky, env("DUDECT_N", 3000));
        System.out.printf("DUDECT positive control (leaky square-and-multiply): max|t|=%.1f%n", got);
        assertTrue(got >= 10, "harness is blind: leaky control gave max|t|=" + got + "; the verdict would be vacuous");
    }

    @Test
    void ctExpIsConstantTime() {
        BigInteger mod = modulus();
        BigInteger base = mod.shiftRight(3), e = randomExp(mod);
        assertEquals(base.modPow(e, mod), CtExp.exp(base, e, mod), "CtExp wrong; refusing to time it");
        double limit = env("DUDECT_T", 10);
        double tv = measure(CtExp::exp, env("DUDECT_N", 3000));
        System.out.printf("DUDECT ctExp fixed-vs-random: max|t|=%.2f (limit %.0f)%n", tv, limit);
        assertTrue(tv < limit, "CtExp timing depends on the exponent: max|t|=" + tv);
    }
}

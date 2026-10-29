package dev.realmid.sdk.split;

import org.junit.jupiter.api.Test;

import java.math.BigInteger;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.SecureRandom;

import static org.junit.jupiter.api.Assertions.*;

/** R27: the secret exponent path uses the hand-written constant-time ladder, never BigInteger.modPow. */
class CtExpTest {
    static final String DIR = "src/main/java/dev/realmid/sdk/split/";

    @Test
    void secretPathHasNoVariableTimeBigIntegerArithmetic() throws Exception {
        String ct = Files.readString(Path.of(DIR + "CtExp.java"));
        int b = ct.indexOf("// PUBLIC-BEGIN"), e = ct.indexOf("// PUBLIC-END");
        assertTrue(b > 0 && e > b, "PUBLIC markers present");
        String secret = ct.substring(0, b) + ct.substring(e);
        // strip comments so prose naming modPow does not trip the scan
        secret = secret.replaceAll("(?s)/\\*.*?\\*/", "").replaceAll("//[^\n]*", "");
        for (String bad : new String[]{"modPow", ".multiply(", ".mod(", ".pow(", ".testBit(", ".shiftRight(",
                ".shiftLeft(", ".divide(", ".modInverse("}) {
            assertFalse(secret.contains(bad), "CtExp secret path uses " + bad);
        }
        String cs = Files.readString(Path.of(DIR + "CoSigner.java"));
        assertFalse(cs.contains("ladderExp"), "old BigInteger ladder is gone");
        assertTrue(cs.contains("CtExp.exp("), "CoSigner uses CtExp");
        int count = cs.split("modPow\\(", -1).length - 1;
        assertEquals(1, count, "only the PUBLIC verify (s^e) may call modPow in CoSigner");
        assertTrue(cs.contains("s.modPow(e, n)"), "the lone modPow is the public verify");
    }

    @Test
    void matchesModPowAcrossWidthsAndEdgeExponents() {
        SecureRandom r = new SecureRandom();
        int examined = 0;
        for (int bits : new int[]{2, 3, 31, 32, 33, 64, 65, 127, 512, 1024, 2048}) {
            for (int k = 0; k < 6; k++) {
                BigInteger mod = new BigInteger(bits, r).setBit(0).setBit(bits - 1);
                if (mod.equals(BigInteger.ONE)) continue;
                BigInteger base = new BigInteger(bits + 8, r);
                BigInteger[] exps = {BigInteger.ZERO, BigInteger.ONE, BigInteger.TWO, new BigInteger(bits, r),
                        new BigInteger(bits + 70, r), mod.add(BigInteger.ONE)};
                for (BigInteger ex : exps) {
                    assertEquals(base.modPow(ex, mod), CtExp.exp(base, ex, mod), "bits=" + bits + " exp=" + ex);
                    examined++;
                }
            }
        }
        assertTrue(examined > 300, "examined " + examined);
    }

    @Test
    void refusesEvenModulusOneAndNegativeExponent() {
        assertThrows(IllegalArgumentException.class, () -> CtExp.exp(BigInteger.TWO, BigInteger.TEN, BigInteger.valueOf(100)));
        assertThrows(IllegalArgumentException.class, () -> CtExp.exp(BigInteger.TWO, BigInteger.TEN, BigInteger.ONE));
        assertThrows(IllegalArgumentException.class, () -> CtExp.exp(BigInteger.TWO, BigInteger.valueOf(-1), BigInteger.valueOf(101)));
    }
}

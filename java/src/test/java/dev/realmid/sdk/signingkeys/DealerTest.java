package dev.realmid.sdk.signingkeys;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.math.BigInteger;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.SecureRandom;
import java.security.interfaces.RSAPrivateCrtKey;
import java.util.HexFormat;

import static org.junit.jupiter.api.Assertions.*;

/** SPEC14_14_dealer: the four dealer checks (shape is covered by RotationTest). */
class DealerTest {

    static BigInteger hex(String s) { return new BigInteger(1, HexFormat.of().parseHex(s)); }

    @Test
    void vectorSplitIsLambdaNotPhi() throws Exception {
        JsonNode root = new ObjectMapper().readTree(Files.readString(Path.of("../testdata/split-vectors/vectors.json")));
        JsonNode dealer = root.get("dealer");
        assertNotNull(dealer, "vectors.json has no dealer case");
        BigInteger p = hex(root.at("/key/p").asText()), q = hex(root.at("/key/q").asText());
        BigInteger d = hex(root.at("/key/d").asText()), dRi = hex(dealer.get("d_ri").asText());
        assertTrue(dRi.compareTo(d) > 0, "dealer case must have d_ri > d");
        assertEquals(hex(dealer.get("d_partner").asText()), SigningKeysClient.splitWithDRi(p, q, d, dRi));
    }

    @Test
    void zeroHalvesAreRefused() {
        BigInteger p = BigInteger.valueOf(61), q = BigInteger.valueOf(53), d = BigInteger.valueOf(413);
        assertThrows(IllegalArgumentException.class, () -> SigningKeysClient.splitWithDRi(p, q, d, BigInteger.ZERO));
        assertThrows(IllegalArgumentException.class, () -> SigningKeysClient.splitWithDRi(p, q, d, d));
        assertThrows(IllegalArgumentException.class, () -> SigningKeysClient.splitWithDRi(p, q, d, BigInteger.valueOf(780)));
    }

    @Test
    void rangeAndRoundTripOver20Deals() throws Exception {
        KeyPairGenerator g = KeyPairGenerator.getInstance("RSA");
        g.initialize(2048);
        SecureRandom rnd = new SecureRandom();
        for (int i = 0; i < 20; i++) {
            KeyPair kp = g.generateKeyPair();
            RSAPrivateCrtKey priv = (RSAPrivateCrtKey) kp.getPrivate();
            BigInteger[] halves = SigningKeysClient.splitExponent(priv, rnd);
            BigInteger p1 = priv.getPrimeP().subtract(BigInteger.ONE), q1 = priv.getPrimeQ().subtract(BigInteger.ONE);
            BigInteger lam = p1.multiply(q1).divide(p1.gcd(q1));
            for (BigInteger x : halves) {
                assertTrue(x.signum() > 0 && x.compareTo(lam) < 0, "deal " + i + " half out of [1, lambda)");
            }
            BigInteger n = priv.getModulus(), m = new BigInteger(1, "round trip".getBytes());
            BigInteger s = m.modPow(halves[0], n).multiply(m.modPow(halves[1], n)).mod(n);
            assertEquals(m.modPow(priv.getPrivateExponent(), n), s, "deal " + i);
        }
    }
}

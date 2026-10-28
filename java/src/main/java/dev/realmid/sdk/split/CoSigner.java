package dev.realmid.sdk.split;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.realmid.sdk.ErrorCode;
import dev.realmid.sdk.RealmException;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Base64;
import java.util.Locale;

/**
 * Completes RI's half-signature with the partner's share (SPEC 14.2, 14.3, 14.6; mirrors sdk/go cosign.go).
 * RI holds d_ri and the partner d_partner of one RSA exponent, d = d_ri + d_partner (mod lambda). RI answers
 * {@code s_ri = m^d_ri mod n} over the EMSA-PKCS1-v1_5/SHA-256 encoding {@code m}; the partner multiplies by
 * {@code m^d_partner} and gets an ordinary RS256 signature. {@code s^e == m} is checked before anything is
 * released, so a corrupt partial or a wrong share is an error and no token. Every failure is a {@link RealmException}.
 */
public final class CoSigner {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final byte[] SHA256_DIGEST_INFO = {0x30, 0x31, 0x30, 0x0d, 0x06, 0x09, 0x60, (byte) 0x86, 0x48, 0x01,
            0x65, 0x03, 0x04, 0x02, 0x01, 0x05, 0x00, 0x04, 0x20};

    private CoSigner() {}

    private static RealmException refuse(ErrorCode c, String m) {
        return new RealmException(c, "realmid: " + m);
    }

    private static byte[] sha256(byte[] in) {
        try {
            return MessageDigest.getInstance("SHA-256").digest(in);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    private static byte[] unb64(String s) {
        try {
            return Base64.getUrlDecoder().decode(s.replaceAll("=+$", ""));
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    private static BigInteger b64Int(String s, String what) {
        byte[] b = s == null ? null : unb64(s);
        if (b == null || b.length == 0) throw refuse(ErrorCode.MALFORMED, what + " is not base64url");
        return new BigInteger(1, b);
    }

    private static BigInteger emsaInt(byte[] digest, int k) {
        byte[] t = new byte[SHA256_DIGEST_INFO.length + digest.length];
        System.arraycopy(SHA256_DIGEST_INFO, 0, t, 0, SHA256_DIGEST_INFO.length);
        System.arraycopy(digest, 0, t, SHA256_DIGEST_INFO.length, digest.length);
        if (k < t.length + 11 || digest.length != 32) {
            throw refuse(ErrorCode.MALFORMED, "modulus too short for the signature encoding");
        }
        byte[] em = new byte[k];
        em[1] = 0x01;
        for (int i = 2; i < k - t.length - 1; i++) em[i] = (byte) 0xff;
        System.arraycopy(t, 0, em, k - t.length, t.length);
        return new BigInteger(1, em);
    }

    /**
     * base^exp mod n by a Montgomery ladder over a FIXED bit count (the modulus length, not the exponent's), so
     * the operation sequence does not depend on the exponent's bits. Deliberately NOT base-blinded: blinding is
     * valid only for the FULL private exponent and corrupts a PARTIAL one. BigInteger is not constant-time.
     */
    static BigInteger ladderExp(BigInteger base, BigInteger exp, BigInteger n) {
        BigInteger[] r = {BigInteger.ONE, base};
        for (int i = n.bitLength() - 1; i >= 0; i--) {
            int b = exp.testBit(i) ? 1 : 0;
            BigInteger prod = r[0].multiply(r[1]).mod(n);
            BigInteger sq = r[b].multiply(r[b]).mod(n);
            r[1 - b] = prod;
            r[b] = sq;
        }
        return r[0];
    }

    private static byte[] fixed(BigInteger v, int k) {
        byte[] raw = v.toByteArray();
        byte[] out = new byte[k];
        int copy = Math.min(raw.length, k);
        System.arraycopy(raw, raw.length - copy, out, k - copy, copy);
        return out;
    }

    private static byte[] completeDigest(ShareEntry entry, byte[] digest, byte[] partialRi) {
        BigInteger n = b64Int(entry.n(), "share modulus");
        BigInteger e = b64Int(entry.e(), "share exponent");
        if (n.bitLength() < 2048 || !n.testBit(0) || e.bitLength() > 62 || e.longValue() < 3) {
            throw refuse(ErrorCode.MALFORMED, "share public key is not a usable RSA key");
        }
        int k = (n.bitLength() + 7) / 8;
        BigInteger dp = b64Int(entry.dPartner(), "share d_partner");
        BigInteger m = emsaInt(digest, k);
        BigInteger sRi = new BigInteger(1, partialRi == null ? new byte[0] : partialRi);
        if (partialRi == null || partialRi.length == 0 || sRi.signum() == 0 || sRi.compareTo(n) >= 0) {
            throw refuse(ErrorCode.BAD_SIGNATURE, "RealmID's partial signature is out of range");
        }
        BigInteger s = sRi.multiply(ladderExp(m, dp, n)).mod(n);
        if (!s.modPow(e, n).equals(m)) {
            throw refuse(ErrorCode.BAD_SIGNATURE,
                    "the finished signature does not verify under the pinned key; refusing to release it");
        }
        return fixed(s, k);
    }

    /** s = partial_ri * m^d_partner mod n for the SHA-256 of {@code signingInput}; verified before return. */
    public static byte[] completePartial(ShareEntry entry, String signingInput, byte[] partialRi) {
        return completeDigest(entry, sha256(signingInput.getBytes(StandardCharsets.UTF_8)), partialRi);
    }

    /** Handshake: the digest is sha256("realmid-split-handshake/v1|realm|kid|nonce"), used directly. */
    public static byte[] completeHandshake(ShareEntry entry, String realm, String kid, String nonce,
                                           byte[] partialRi) {
        byte[] msg = sha256(("realmid-split-handshake/v1|" + realm + "|" + kid + "|" + nonce)
                .getBytes(StandardCharsets.UTF_8));
        return completeDigest(entry, msg, partialRi);
    }

    private static boolean accessTokenTyp(JsonNode typ) {
        if (typ == null || !typ.isTextual()) return false;
        String t = typ.asText().toLowerCase(Locale.ROOT); // ROOT lowering is ASCII-safe for this allowlist
        return t.equals("jwt") || t.equals("at+jwt") || t.equals("application/at+jwt");
    }

    /** Finishes a JWT; refuses a foreign alg, typ or iss; releases nothing unless the result verifies. */
    public static String coSign(ShareEntry entry, String expectIssuer, PartialSigning p) {
        byte[] hb = p.header() == null ? null : unb64(p.header());
        if (hb == null) throw refuse(ErrorCode.MALFORMED, "partial signing header is not base64url");
        JsonNode hdr;
        try {
            hdr = JSON.readTree(hb);
        } catch (Exception ex) {
            throw refuse(ErrorCode.MALFORMED, "partial signing header is not JSON");
        }
        if (hdr == null || !hdr.isObject() || !"RS256".equals(hdr.path("alg").asText(null))
                || !accessTokenTyp(hdr.get("typ"))) {
            throw refuse(ErrorCode.WRONG_ALGORITHM, "refusing to co-sign a token with a foreign alg or typ");
        }
        String hk = hdr.path("kid").asText("");
        if (p.kid() != null && !p.kid().isEmpty() && !hk.isEmpty() && !hk.equals(p.kid())) {
            throw refuse(ErrorCode.UNKNOWN_KID, "partial signing kid does not match the header");
        }
        byte[] pb = p.payload() == null ? null : unb64(p.payload());
        if (pb == null) throw refuse(ErrorCode.MALFORMED, "partial signing payload is not base64url");
        String iss;
        try {
            iss = JSON.readTree(pb).path("iss").asText("");
        } catch (Exception ex) {
            iss = "";
        }
        if (iss.isEmpty() || !iss.equals(expectIssuer)) {
            throw refuse(ErrorCode.WRONG_ISSUER, "refusing to co-sign a token for a foreign issuer");
        }
        byte[] ri = p.partialRi() == null ? null : unb64(p.partialRi());
        if (ri == null) throw refuse(ErrorCode.MALFORMED, "partial_ri is not base64url");
        byte[] sig = completePartial(entry, p.header() + "." + p.payload(), ri);
        return p.header() + "." + p.payload() + "." + Base64.getUrlEncoder().withoutPadding().encodeToString(sig);
    }

}

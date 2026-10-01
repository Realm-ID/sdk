package dev.realmid.sdk.verifier;

import com.fasterxml.jackson.databind.ObjectMapper;

import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.Signature;
import java.security.interfaces.RSAPrivateKey;
import java.security.interfaces.RSAPublicKey;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** A throwaway RSA signing key for tests: signs RS256 access tokens and serves the matching JWKS. */
public final class VerifierTestKeys {

    private static final ObjectMapper M = new ObjectMapper();
    private final KeyPair pair;
    public static final String KID = "kid-1";

    public VerifierTestKeys() throws Exception {
        KeyPairGenerator gen = KeyPairGenerator.getInstance("RSA");
        gen.initialize(2048);
        pair = gen.generateKeyPair();
    }

    public Map<String, Object> jwks() {
        return Map.of("keys", List.of(VerifierTest.jwkFor((RSAPublicKey) pair.getPublic(), KID)));
    }

    public String sign(Map<String, Object> payload) throws Exception {
        Map<String, Object> hdr = new LinkedHashMap<>();
        hdr.put("alg", "RS256");
        hdr.put("typ", "JWT");
        hdr.put("kid", KID);
        String signing = b64(M.writeValueAsBytes(hdr)) + "." + b64(M.writeValueAsBytes(payload));
        Signature sig = Signature.getInstance("SHA256withRSA");
        sig.initSign((RSAPrivateKey) pair.getPrivate());
        sig.update(signing.getBytes());
        return signing + "." + b64(sig.sign());
    }

    private static String b64(byte[] b) { return Base64.getUrlEncoder().withoutPadding().encodeToString(b); }
}

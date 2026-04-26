package dev.realmid.sdk.verifier;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import dev.realmid.sdk.ErrorCode;
import dev.realmid.sdk.RealmException;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.io.OutputStream;
import java.math.BigInteger;
import java.net.InetSocketAddress;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.Signature;
import java.security.interfaces.RSAPrivateKey;
import java.security.interfaces.RSAPublicKey;
import java.time.Instant;
import java.util.Base64;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import dev.realmid.sdk.Claims;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

class VerifierTest {

    private static final String REALM_ID = "01HXYZREALM";
    private static final String AUDIENCE = "example.com";
    private static final ObjectMapper M = new ObjectMapper();

    private HttpServer server;
    private String baseUrl;
    private KeyPair keyPair;
    private final String kid = "kid-1";

    @BeforeEach
    void setUp() throws Exception {
        KeyPairGenerator gen = KeyPairGenerator.getInstance("RSA");
        gen.initialize(2048);
        keyPair = gen.generateKeyPair();

        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        Map<String, Object> jwk = jwkFor((RSAPublicKey) keyPair.getPublic(), kid);
        Map<String, Object> doc = Map.of("keys", List.of(jwk));
        byte[] body = M.writeValueAsBytes(doc);

        server.createContext("/" + REALM_ID + "/.well-known/jwks.json", exchange -> {
            exchange.getResponseHeaders().add("content-type", "application/json");
            exchange.sendResponseHeaders(200, body.length);
            try (OutputStream os = exchange.getResponseBody()) {
                os.write(body);
            }
        });
        server.start();
        baseUrl = "http://127.0.0.1:" + server.getAddress().getPort();
    }

    @AfterEach
    void tearDown() {
        server.stop(0);
    }

    private Verifier newVerifier() {
        return new Verifier(baseUrl, AUDIENCE, null, null, null, null, null, null, null);
    }

    @Test
    void happyPath() throws Exception {
        Verifier v = newVerifier();
        Map<String, Object> claims = baseClaims();
        claims.put("tenant_id", "01HTENANT");
        claims.put("role", "owner");
        claims.put("jti", "01HJTI");
        claims.put("custom_field", "x");

        Claims got = v.verify(signToken(claims, kid));
        assertEquals("01HTENANT", got.tenantId());
        assertEquals("owner", got.role());
        assertEquals("01HJTI", got.jwtId());
        assertEquals("x", got.extra().get("custom_field"));
    }

    @Test
    void wrongAudience() throws Exception {
        Verifier v = newVerifier();
        Map<String, Object> claims = baseClaims();
        claims.put("aud", "other");
        RealmException ex = assertThrows(RealmException.class, () -> v.verify(signToken(claims, kid)));
        assertEquals(ErrorCode.WRONG_AUDIENCE, ex.getCode());
    }

    @Test
    void wrongIssuer() throws Exception {
        Verifier v = newVerifier();
        Map<String, Object> claims = baseClaims();
        claims.put("iss", "https://evil.example/" + REALM_ID);
        RealmException ex = assertThrows(RealmException.class, () -> v.verify(signToken(claims, kid)));
        assertEquals(ErrorCode.WRONG_ISSUER, ex.getCode());
    }

    @Test
    void expired() throws Exception {
        Verifier v = newVerifier();
        Map<String, Object> claims = baseClaims();
        claims.put("exp", Instant.now().minusSeconds(3600).getEpochSecond());
        RealmException ex = assertThrows(RealmException.class, () -> v.verify(signToken(claims, kid)));
        assertEquals(ErrorCode.EXPIRED, ex.getCode());
    }

    @Test
    void notYetValid() throws Exception {
        Verifier v = newVerifier();
        Map<String, Object> claims = baseClaims();
        claims.put("nbf", Instant.now().plusSeconds(3600).getEpochSecond());
        RealmException ex = assertThrows(RealmException.class, () -> v.verify(signToken(claims, kid)));
        assertEquals(ErrorCode.NOT_YET_VALID, ex.getCode());
    }

    @Test
    void malformed() {
        Verifier v = newVerifier();
        RealmException ex = assertThrows(RealmException.class, () -> v.verify("not.a.real.token"));
        assertEquals(ErrorCode.MALFORMED, ex.getCode());
    }

    @Test
    void unknownKid() throws Exception {
        Verifier v = newVerifier();
        RealmException ex = assertThrows(RealmException.class,
                () -> v.verify(signToken(baseClaims(), "kid-unknown")));
        assertEquals(ErrorCode.UNKNOWN_KID, ex.getCode());
    }

    @Test
    void badSignature() throws Exception {
        Verifier v = newVerifier();
        String tok = signToken(baseClaims(), kid);
        String[] parts = tok.split("\\.");
        String mangled = parts[0] + "." + parts[1] + "."
                + Base64.getUrlEncoder().withoutPadding().encodeToString("not-a-real-sig".getBytes());
        RealmException ex = assertThrows(RealmException.class, () -> v.verify(mangled));
        assertEquals(ErrorCode.BAD_SIGNATURE, ex.getCode());
    }

    @Test
    void wrongAlgorithm() throws Exception {
        Verifier v = newVerifier();
        String hdr = b64url(M.writeValueAsBytes(Map.of("alg", "HS256", "typ", "JWT", "kid", kid)));
        String pl = b64url(M.writeValueAsBytes(baseClaims()));
        String fake = hdr + "." + pl + "." + b64url("xxxx".getBytes());
        RealmException ex = assertThrows(RealmException.class, () -> v.verify(fake));
        assertEquals(ErrorCode.WRONG_ALGORITHM, ex.getCode());
    }

    @Test
    void requiresBaseUrlAndAudience() {
        assertThrows(IllegalArgumentException.class,
                () -> new Verifier("", "x", null, null, null, null, null, null, null));
        assertThrows(IllegalArgumentException.class,
                () -> new Verifier("https://example.com", null, null, null, null, null, null, null, null));
    }

    // ----- helpers -----

    private Map<String, Object> baseClaims() {
        long now = Instant.now().getEpochSecond();
        Map<String, Object> c = new LinkedHashMap<>();
        c.put("iss", baseUrl + "/" + REALM_ID);
        c.put("sub", "01HUSER");
        c.put("aud", AUDIENCE);
        c.put("iat", now);
        c.put("exp", now + 600);
        return c;
    }

    private String signToken(Map<String, Object> claims, String useKid) throws Exception {
        Map<String, Object> hdr = new LinkedHashMap<>();
        hdr.put("alg", "RS256");
        hdr.put("typ", "JWT");
        hdr.put("kid", useKid);
        String hb = b64url(M.writeValueAsBytes(hdr));
        String cb = b64url(M.writeValueAsBytes(claims));
        String signing = hb + "." + cb;
        Signature sig = Signature.getInstance("SHA256withRSA");
        sig.initSign((RSAPrivateKey) keyPair.getPrivate());
        sig.update(signing.getBytes());
        return signing + "." + b64url(sig.sign());
    }

    private static String b64url(byte[] b) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(b);
    }

    static Map<String, Object> jwkFor(RSAPublicKey pub, String kid) {
        Map<String, Object> jwk = new HashMap<>();
        jwk.put("kty", "RSA");
        jwk.put("kid", kid);
        jwk.put("alg", "RS256");
        jwk.put("use", "sig");
        jwk.put("n", b64url(toUnsignedBytes(pub.getModulus())));
        jwk.put("e", b64url(toUnsignedBytes(pub.getPublicExponent())));
        return jwk;
    }

    static byte[] toUnsignedBytes(BigInteger v) {
        byte[] raw = v.toByteArray();
        if (raw[0] == 0 && raw.length > 1) {
            byte[] trimmed = new byte[raw.length - 1];
            System.arraycopy(raw, 1, trimmed, 0, trimmed.length);
            return trimmed;
        }
        return raw;
    }
}

package dev.realmid.sdk.verifier;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import dev.realmid.sdk.ErrorCode;
import dev.realmid.sdk.RealmException;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.Signature;
import java.security.interfaces.RSAPrivateKey;
import java.security.interfaces.RSAPublicKey;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

/** SPEC §2: JWKS response shape (2xx parsed, kid-less key ignored, unusable key with a kid fails the set). */
class JwksShapeTest {

    private static final String REALM_ID = "01HXYZREALM";
    private static final String AUDIENCE = "example.com";
    private static final ObjectMapper M = new ObjectMapper();

    private HttpServer server;
    private String baseUrl;
    private KeyPair keyPair;
    private volatile String body;
    private volatile int status = 200;
    private final Clock clock = Clock.fixed(Instant.parse("2026-04-01T00:00:00Z"), ZoneOffset.UTC);

    @BeforeEach
    void setUp() throws Exception {
        KeyPairGenerator gen = KeyPairGenerator.getInstance("RSA");
        gen.initialize(2048);
        keyPair = gen.generateKeyPair();
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/" + REALM_ID + "/.well-known/jwks.json", exchange -> {
            byte[] b = body.getBytes();
            exchange.sendResponseHeaders(status, b.length);
            try (OutputStream os = exchange.getResponseBody()) {
                os.write(b);
            }
        });
        server.start();
        baseUrl = "http://127.0.0.1:" + server.getAddress().getPort();
    }

    @AfterEach
    void tearDown() {
        server.stop(0);
    }

    private String setWith(Map<String, Object> extra) throws Exception {
        List<Object> keys = new ArrayList<>();
        keys.add(VerifierTest.jwkFor((RSAPublicKey) keyPair.getPublic(), "kid-known"));
        if (extra != null) keys.add(extra);
        return M.writeValueAsString(Map.of("keys", keys));
    }

    private static Map<String, Object> key(String kid, String n, String e) {
        Map<String, Object> k = new LinkedHashMap<>();
        k.put("kty", "RSA");
        if (kid != null) k.put("kid", kid);
        if (n != null) k.put("n", n);
        if (e != null) k.put("e", e);
        return k;
    }

    private String sign() throws Exception {
        long now = clock.instant().getEpochSecond();
        Map<String, Object> claims = new LinkedHashMap<>();
        claims.put("iss", baseUrl + "/" + REALM_ID);
        claims.put("sub", "01HUSER");
        claims.put("aud", AUDIENCE);
        claims.put("iat", now);
        claims.put("exp", now + 600);
        Map<String, Object> hdr = new LinkedHashMap<>();
        hdr.put("alg", "RS256");
        hdr.put("typ", "JWT");
        hdr.put("kid", "kid-known");
        Base64.Encoder b = Base64.getUrlEncoder().withoutPadding();
        String signing = b.encodeToString(M.writeValueAsBytes(hdr)) + "." + b.encodeToString(M.writeValueAsBytes(claims));
        Signature sig = Signature.getInstance("SHA256withRSA");
        sig.initSign((RSAPrivateKey) keyPair.getPrivate());
        sig.update(signing.getBytes());
        return signing + "." + b.encodeToString(sig.sign());
    }

    private void verifyOnce() throws Exception {
        Verifier v = new Verifier(baseUrl, AUDIENCE, null, null, null, null, null, clock, null, null, null, null, REALM_ID);
        String token = sign();
        v.verify(token);
    }

    private void expect(ErrorCode code) throws Exception {
        RealmException ex = assertThrows(RealmException.class, this::verifyOnce);
        assertEquals(code, ex.getCode());
    }

    @Test
    void anyTwoXxIsParsed() throws Exception {
        body = setWith(null);
        for (int s : new int[] {200, 201, 203}) {
            status = s;
            assertDoesNotThrow(this::verifyOnce);
        }
    }

    @Test
    void nonTwoXxIsFetchFailed() throws Exception {
        body = setWith(null);
        for (int s : new int[] {404, 500}) {
            status = s;
            expect(ErrorCode.JWKS_FETCH_FAILED);
        }
    }

    @Test
    void keyWithoutKidIsIgnored() throws Exception {
        for (Map<String, Object> k : List.of(key(null, "@@@", "AQAB"), key(null, null, null), key(null, "AQAB", "AQAB"))) {
            body = setWith(k);
            assertDoesNotThrow(this::verifyOnce);
        }
    }

    @Test
    void keyWithKidAndUnusableMaterialFailsTheSet() throws Exception {
        List<Map<String, Object>> bad = List.of(
                key("kid-bad", null, "AQAB"),
                key("kid-bad", "AQAB", null),
                key("kid-bad", "", "AQAB"),
                key("kid-bad", "AQAB", ""),
                key("kid-bad", "@@@", "AQAB"),
                key("kid-bad", "AQAB", "@@@"),
                key("kid-bad", VerifierTest.jwkFor((RSAPublicKey) keyPair.getPublic(), "x").get("n") + "==", "AQAB"),
                key("kid-bad", "AQAB", "AQABAQ=="));
        for (Map<String, Object> k : bad) {
            body = setWith(k);
            expect(ErrorCode.JWKS_FETCH_FAILED);
        }
    }

    @Test
    void nonStringKidIsSkipped() throws Exception {
        List<Object> kids = new ArrayList<>();
        kids.add(123);
        kids.add(true);
        kids.add(Map.of("a", 1));
        kids.add(List.of("x"));
        kids.add(null);
        for (Object kid : kids) {
            Map<String, Object> k = key(null, "AQAB", "AQAB");
            k.put("kid", kid);
            body = setWith(k);
            assertDoesNotThrow(this::verifyOnce);
        }
    }

    @Test
    void nonObjectTopLevelIsFetchFailed() throws Exception {
        for (String b : List.of("", "[]", "\"x\"", "5")) {
            body = b;
            expect(ErrorCode.JWKS_FETCH_FAILED);
        }
    }

    @Test
    void absentOrNullKeysIsUnknownKid() throws Exception {
        for (String b : List.of("{}", "{\"keys\":null}", "{\"keys\":[]}")) {
            body = b;
            expect(ErrorCode.UNKNOWN_KID);
        }
    }
}

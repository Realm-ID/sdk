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
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

/** SPEC §2: any failure to fetch or parse the JWKS is jwks_fetch_failed and is the recorded attempt. */
class JwksFailureTest {

    private static final String REALM_ID = "01HXYZREALM";
    private static final String AUDIENCE = "example.com";
    private static final ObjectMapper M = new ObjectMapper();

    private HttpServer server;
    private String baseUrl;
    private KeyPair keyPair;
    private volatile String body;
    private final AtomicInteger fetches = new AtomicInteger();
    private final Clock clock = Clock.fixed(Instant.parse("2026-04-01T00:00:00Z"), ZoneOffset.UTC);

    @BeforeEach
    void setUp() throws Exception {
        KeyPairGenerator gen = KeyPairGenerator.getInstance("RSA");
        gen.initialize(2048);
        keyPair = gen.generateKeyPair();
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/" + REALM_ID + "/.well-known/jwks.json", exchange -> {
            fetches.incrementAndGet();
            byte[] b = body.getBytes();
            exchange.sendResponseHeaders(200, b.length);
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

    private Map<String, Object> good() throws Exception {
        return VerifierTest.jwkFor((RSAPublicKey) keyPair.getPublic(), "kid-known");
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

    private Verifier newVerifier() {
        return new Verifier(baseUrl, AUDIENCE, null, null, null, null, null, clock, null, null, null, null, REALM_ID);
    }

    private void assertFetchFailedAndRecorded(String badBody) throws Exception {
        body = badBody;
        Verifier v = newVerifier();
        String token = sign();
        RealmException ex = assertThrows(RealmException.class, () -> v.verify(token));
        assertEquals(ErrorCode.JWKS_FETCH_FAILED, ex.getCode());
        assertEquals(1, fetches.get());
    }

    @Test
    void bodyThatIsNotJsonIsFetchFailed() throws Exception {
        assertFetchFailedAndRecorded("<html>not json</html>");
    }

    @Test
    void keyWithUndecodableModulusFailsTheWholeSet() throws Exception {
        Map<String, Object> bad = new LinkedHashMap<>();
        bad.put("kty", "RSA");
        bad.put("kid", "kid-bad");
        bad.put("n", "@@@");
        bad.put("e", "AQAB");
        assertFetchFailedAndRecorded(M.writeValueAsString(Map.of("keys", List.of(good(), bad))));
    }

    @Test
    void keyWithUndecodableExponentFailsTheWholeSet() throws Exception {
        Map<String, Object> bad = new LinkedHashMap<>();
        bad.put("kty", "RSA");
        bad.put("kid", "kid-bad");
        bad.put("n", "AQAB");
        bad.put("e", "@@@");
        assertFetchFailedAndRecorded(M.writeValueAsString(Map.of("keys", List.of(good(), bad))));
    }

    @Test
    void emptyKeysArrayIsUnknownKid() throws Exception {
        body = "{\"keys\":[]}";
        Verifier v = newVerifier();
        String token = sign();
        RealmException ex = assertThrows(RealmException.class, () -> v.verify(token));
        assertEquals(ErrorCode.UNKNOWN_KID, ex.getCode());
    }
}

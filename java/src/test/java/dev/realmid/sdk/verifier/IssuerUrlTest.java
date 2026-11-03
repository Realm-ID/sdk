package dev.realmid.sdk.verifier;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import dev.realmid.sdk.ErrorCode;
import dev.realmid.sdk.Realm;
import dev.realmid.sdk.RealmException;
import dev.realmid.sdk.session.MemorySessionStore;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * SPEC §1 / §5 / §14.4: issuerUrl is the host the issuer stamps into {@code iss}
 * (default baseUrl). Only the iss checks read it; every fetch stays on baseUrl.
 * Mirrors go/issuer_url_test.go.
 */
class IssuerUrlTest {

    private static final String REALM_ID = "01HXYZREALM";
    private static final String AUDIENCE = "example.com";
    private static final String PUBLIC_ISSUER = "https://public.example";

    private HttpServer server;
    private String baseUrl;
    private VerifierTestKeys keys;
    private final AtomicInteger jwksHits = new AtomicInteger();

    @BeforeEach
    void setUp() throws Exception {
        keys = new VerifierTestKeys();
        byte[] body = new ObjectMapper().writeValueAsBytes(keys.jwks());
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/" + REALM_ID + "/.well-known/jwks.json", exchange -> {
            jwksHits.incrementAndGet();
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

    private Realm realm(String base, String issuerUrl) {
        return Realm.builder().sessionStore(new MemorySessionStore())
                .realmId(REALM_ID).apiKey("rk_live_test").baseUrl(base)
                .audience(AUDIENCE).issuerUrl(issuerUrl).build();
    }

    private String token(String iss) throws Exception {
        long now = Instant.now().getEpochSecond();
        Map<String, Object> c = new LinkedHashMap<>();
        c.put("iss", iss);
        c.put("sub", "01HUSER");
        c.put("aud", AUDIENCE);
        c.put("iat", now);
        c.put("exp", now + 600);
        return keys.sign(c);
    }

    @Test
    void verifiesAgainstPublicIssuerWhileFetchingInternal() throws Exception {
        Realm r = realm(baseUrl, PUBLIC_ISSUER);
        r.verify(token(PUBLIC_ISSUER + "/" + REALM_ID));
        // Positive control: the JWKS fetch went to baseUrl (the internal server).
        assertEquals(1, jwksHits.get());
    }

    @Test
    void unsetStillChecksBaseUrl() throws Exception {
        Realm r = realm(baseUrl, null);
        RealmException ex = assertThrows(RealmException.class,
                () -> r.verify(token(PUBLIC_ISSUER + "/" + REALM_ID)));
        assertEquals(ErrorCode.WRONG_ISSUER, ex.getCode());
        r.verify(token(baseUrl + "/" + REALM_ID));
    }

    @Test
    void trailingSlashTrimmed() throws Exception {
        Realm r = realm(baseUrl, PUBLIC_ISSUER + "/");
        r.verify(token(PUBLIC_ISSUER + "/" + REALM_ID));
    }

    @Test
    void blankFallsBackToBaseUrl() throws Exception {
        for (String blank : new String[] {"", "   ", "\t\n"}) {
            Realm r = realm(baseUrl, blank);
            r.verify(token(baseUrl + "/" + REALM_ID));
            RealmException ex = assertThrows(RealmException.class,
                    () -> r.verify(token(PUBLIC_ISSUER + "/" + REALM_ID)), "blank=[" + blank + "]");
            assertEquals(ErrorCode.WRONG_ISSUER, ex.getCode());
        }
    }

    @Test
    void wrongIssuerNamesReceivedIssOnly() throws Exception {
        Realm r = realm(baseUrl, PUBLIC_ISSUER);
        RealmException ex = assertThrows(RealmException.class,
                () -> r.verify(token("https://evil.example/" + REALM_ID)));
        assertEquals(ErrorCode.WRONG_ISSUER, ex.getCode());
        assertTrue(ex.getMessage().contains("https://evil.example/" + REALM_ID), ex.getMessage());
        assertFalse(ex.getMessage().contains(PUBLIC_ISSUER), ex.getMessage());
    }

    @Test
    void otherRealmIssRefused() throws Exception {
        Realm r = realm(baseUrl, PUBLIC_ISSUER);
        for (String iss : new String[] {PUBLIC_ISSUER + "/01HOTHERREALM", PUBLIC_ISSUER + "/" + REALM_ID + "X"}) {
            RealmException ex = assertThrows(RealmException.class, () -> r.verify(token(iss)));
            assertEquals(ErrorCode.WRONG_ISSUER, ex.getCode(), iss);
        }
        // Refused before key resolution: no JWKS fetch happened.
        assertEquals(0, jwksHits.get());
    }

    @Test
    void coSignerExpectedIssuerUsesIssuerUrl() {
        assertEquals(PUBLIC_ISSUER + "/" + REALM_ID,
                realm("http://internal:8080/", PUBLIC_ISSUER + "/").splitState().expectedIssuer());
        assertEquals("http://internal:8080/" + REALM_ID,
                realm("http://internal:8080/", "").splitState().expectedIssuer());
    }
}

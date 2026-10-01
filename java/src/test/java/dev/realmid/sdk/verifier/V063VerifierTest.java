package dev.realmid.sdk.verifier;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import dev.realmid.sdk.Claims;
import dev.realmid.sdk.ErrorCode;
import dev.realmid.sdk.RealmException;
import dev.realmid.sdk.authority.AuthorityCache;
import dev.realmid.sdk.revocation.MemRevocationCache;
import dev.realmid.sdk.revocation.RevocationCache;
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
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** SDK v0.63.0 verifier items: SPEC5_1 (blank sub), SPEC5_1_1 (typ/events), SPEC6_7_6 (sid-keyed revocation). */
class V063VerifierTest {

    private static final String REALM_ID = "01HXYZREALM";
    private static final String AUDIENCE = "example.com";
    private static final ObjectMapper M = new ObjectMapper();

    private HttpServer server;
    private String baseUrl;
    private KeyPair keyPair;
    private final AtomicInteger jwksFetches = new AtomicInteger();

    @BeforeEach
    void setUp() throws Exception {
        KeyPairGenerator gen = KeyPairGenerator.getInstance("RSA");
        gen.initialize(2048);
        keyPair = gen.generateKeyPair();
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        byte[] body = M.writeValueAsBytes(Map.of("keys",
                List.of(VerifierTest.jwkFor((RSAPublicKey) keyPair.getPublic(), "kid-1"))));
        server.createContext("/" + REALM_ID + "/.well-known/jwks.json", ex -> {
            jwksFetches.incrementAndGet();
            ex.getResponseHeaders().add("content-type", "application/json");
            ex.sendResponseHeaders(200, body.length);
            try (OutputStream os = ex.getResponseBody()) { os.write(body); }
        });
        server.start();
        baseUrl = "http://127.0.0.1:" + server.getAddress().getPort();
    }

    @AfterEach
    void tearDown() { server.stop(0); }

    private Verifier verifier() {
        return new Verifier(baseUrl, AUDIENCE, null, null, null, null, null, null, null);
    }

    private Verifier verifier(AuthorityCache a, RevocationCache r) {
        return new Verifier(baseUrl, AUDIENCE, null, null, null, null, null, null, null, a, r);
    }

    // ---- SPEC5_1: blank sub ----------------------------------------------------

    private void assertMalformed401(String token) {
        RealmException ex = assertThrows(RealmException.class, () -> verifier().verify(token));
        assertEquals(ErrorCode.MALFORMED, ex.getCode());
        assertEquals(401, ex.getHttpStatus());
    }

    @Test
    void SPEC5_1_blankSubIsMalformed() throws Exception {
        Map<String, Object> absent = claims();
        absent.remove("sub");
        assertMalformed401(sign(header("JWT"), absent));
        for (Object bad : new Object[]{"", "   ", "\t\n", "\u000b\u000c\r", 42, true}) {
            Map<String, Object> c = claims();
            c.put("sub", bad);
            assertMalformed401(sign(header("JWT"), c));
        }
        Map<String, Object> nul = claims();
        nul.put("sub", null);
        assertMalformed401(sign(header("JWT"), nul));
    }

    @Test
    void SPEC5_1_nbspAndPaddedSubVerifyVerbatim() throws Exception {
        Map<String, Object> c = claims();
        c.put("sub", " ");
        assertEquals(" ", verifier().verify(sign(header("JWT"), c)).subject());
        c.put("sub", " u1 ");
        assertEquals(" u1 ", verifier().verify(sign(header("JWT"), c)).subject());
    }

    @Test
    void SPEC5_1_blankSubRefusedBeforeAuthorityCacheIsConsulted() throws Exception {
        List<String> calls = new ArrayList<>();
        AuthorityCache spy = new AuthorityCache() {
            public void markStale(String s, Instant n, Instant e) { calls.add("mark"); }
            public Instant staleSince(String s) { calls.add("stale"); return null; }
        };
        Map<String, Object> c = claims();
        c.put("sub", "");
        assertThrows(RealmException.class, () -> verifier(spy, null).verify(sign(header("JWT"), c)));
        assertTrue(calls.isEmpty(), "authority cache consulted: " + calls);
        // positive control
        assertEquals("u1", verifier(spy, null).verify(sign(header("JWT"), claims())).subject());
        assertEquals(List.of("stale"), calls);
    }

    @Test
    void SPEC5_1_expiredBlankSubReportsExpired() throws Exception {
        Map<String, Object> c = claims();
        c.put("sub", "");
        c.put("exp", Instant.now().getEpochSecond() - 3600);
        RealmException ex = assertThrows(RealmException.class, () -> verifier().verify(sign(header("JWT"), c)));
        assertEquals(ErrorCode.EXPIRED, ex.getCode());
    }

    // ---- SPEC5_1_1: typ / events -----------------------------------------------

    @Test
    void SPEC5_1_1_typAbsentOrWrongIsMalformed() throws Exception {
        Map<String, Object> noTyp = header("JWT");
        noTyp.remove("typ");
        RealmException ex = assertThrows(RealmException.class, () -> verifier().verify(sign(noTyp, claims())));
        assertEquals(ErrorCode.MALFORMED, ex.getCode());
        assertEquals(401, ex.getHttpStatus());
        assertEquals("unexpected token type: <absent>", ex.getMessage());

        for (Object bad : new Object[]{"logout+jwt", " JWT", "at+jwt ", 42}) {
            Map<String, Object> h = header("JWT");
            h.put("typ", bad);
            RealmException e2 = assertThrows(RealmException.class, () -> verifier().verify(sign(h, claims())),
                    "typ=" + bad);
            assertEquals(ErrorCode.MALFORMED, e2.getCode(), "typ=" + bad);
        }
    }

    @Test
    void SPEC5_1_1_allowlistVerifiesCaseInsensitively() throws Exception {
        for (String typ : new String[]{"JWT", "jwt", "Jwt", "at+jwt", "AT+JWT", "application/at+jwt",
                "Application/AT+JWT"}) {
            assertEquals("u1", verifier().verify(sign(header(typ), claims())).subject(), typ);
        }
    }

    @Test
    void SPEC5_1_1_typRefusedBeforeKidLookup() throws Exception {
        Map<String, Object> h = header("logout+jwt");
        h.put("kid", "unknown-kid");
        int before = jwksFetches.get();
        RealmException ex = assertThrows(RealmException.class, () -> verifier().verify(sign(h, claims())));
        assertEquals(ErrorCode.MALFORMED, ex.getCode());
        assertEquals(before, jwksFetches.get(), "JWKS fetched for a wrongly typed token");
    }

    @Test
    void SPEC5_1_1_eventsClaimRefusedInEveryShape() throws Exception {
        Object[] shapes = {
                Map.of("http://schemas.openid.net/event/backchannel-logout", Map.of()),
                Map.of(), null, List.of("signup")};
        for (Object ev : shapes) {
            Map<String, Object> c = claims();
            c.put("events", ev);
            RealmException ex = assertThrows(RealmException.class, () -> verifier().verify(sign(header("JWT"), c)));
            assertEquals(ErrorCode.MALFORMED, ex.getCode());
            assertEquals("token carries an events claim", ex.getMessage());
        }
    }

    @Test
    void SPEC5_1_1_eventsRefusedBeforeCaches() throws Exception {
        List<String> calls = new ArrayList<>();
        RevocationCache rev = new RevocationCache() {
            public void revoke(String k, Instant u) { calls.add("revoke"); }
            public boolean isRevoked(String k) { calls.add("rev"); return false; }
        };
        AuthorityCache auth = new AuthorityCache() {
            public void markStale(String s, Instant n, Instant e) { calls.add("mark"); }
            public Instant staleSince(String s) { calls.add("stale"); return null; }
        };
        Map<String, Object> c = claims();
        c.put("events", Map.of());
        assertThrows(RealmException.class, () -> verifier(auth, rev).verify(sign(header("JWT"), c)));
        assertTrue(calls.isEmpty(), "caches consulted: " + calls);
    }

    @Test
    void SPEC5_1_1_logoutTokenShapeIsRefused() throws Exception {
        Map<String, Object> c = new LinkedHashMap<>();
        c.put("iss", baseUrl + "/" + REALM_ID);
        c.put("aud", AUDIENCE);
        c.put("iat", Instant.now().getEpochSecond());
        c.put("sid", "s1");
        c.put("events", Map.of("http://schemas.openid.net/event/backchannel-logout", Map.of()));
        assertThrows(RealmException.class, () -> verifier().verify(sign(header("logout+jwt"), c)));
    }

    // ---- SPEC6_7_6: session key everywhere ------------------------------------

    @Test
    void SPEC6_7_6_claimsExposeSidAndKeepItOutOfExtra() throws Exception {
        Map<String, Object> c = claims();
        c.put("sid", "S1");
        Claims got = verifier().verify(sign(header("JWT"), c));
        assertEquals("S1", got.sessionId());
        assertTrue(!got.extra().containsKey("sid"));
        assertNull(verifier().verify(sign(header("JWT"), claims())).sessionId());
    }

    @Test
    void SPEC6_7_6_revocationIsKeyedOnSidWithDifferentJti() throws Exception {
        MemRevocationCache cache = new MemRevocationCache();
        Map<String, Object> c = claims();
        c.put("sid", "S1");
        c.put("jti", "unique-jti-2");
        String token = sign(header("JWT"), c);
        assertEquals("u1", verifier(null, cache).verify(token).subject()); // positive control
        cache.revoke("S1", Instant.now().plusSeconds(60));
        RealmException ex = assertThrows(RealmException.class, () -> verifier(null, cache).verify(token));
        assertEquals(ErrorCode.UNAUTHORIZED, ex.getCode());
    }

    @Test
    void SPEC6_7_6_jtiOnlyTokenFallsBackToJtiAndV062EntriesStillMatch() throws Exception {
        MemRevocationCache cache = new MemRevocationCache();
        Map<String, Object> c = claims();
        c.put("jti", "S1"); // prod v0.126.0 shape: jti IS the session id
        cache.revoke("S1", Instant.now().plusSeconds(60));
        assertThrows(RealmException.class, () -> verifier(null, cache).verify(sign(header("JWT"), c)));
        // Issuer A shape: sid == jti, entry written by v0.62 under the jti
        c.put("sid", "S1");
        assertThrows(RealmException.class, () -> verifier(null, cache).verify(sign(header("JWT"), c)));
    }

    // ---- helpers -----------------------------------------------------------------

    private Map<String, Object> claims() {
        long now = Instant.now().getEpochSecond();
        Map<String, Object> c = new LinkedHashMap<>();
        c.put("iss", baseUrl + "/" + REALM_ID);
        c.put("sub", "u1");
        c.put("aud", AUDIENCE);
        c.put("iat", now);
        c.put("exp", now + 600);
        return c;
    }

    private static Map<String, Object> header(String typ) {
        Map<String, Object> h = new LinkedHashMap<>();
        h.put("alg", "RS256");
        h.put("typ", typ);
        h.put("kid", "kid-1");
        return h;
    }

    private String sign(Map<String, Object> hdr, Map<String, Object> payload) throws Exception {
        String signing = b64(M.writeValueAsBytes(hdr)) + "." + b64(M.writeValueAsBytes(payload));
        Signature sig = Signature.getInstance("SHA256withRSA");
        sig.initSign((RSAPrivateKey) keyPair.getPrivate());
        sig.update(signing.getBytes());
        return signing + "." + b64(sig.sign());
    }

    private static String b64(byte[] b) { return Base64.getUrlEncoder().withoutPadding().encodeToString(b); }
}

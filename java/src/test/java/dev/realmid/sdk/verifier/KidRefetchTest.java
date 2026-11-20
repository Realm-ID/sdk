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
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

class KidRefetchTest {

    private static final String REALM_ID = "01HXYZREALM";
    private static final String AUDIENCE = "example.com";
    private static final ObjectMapper M = new ObjectMapper();

    private HttpServer server;
    private String baseUrl;
    private KeyPair keyPair;
    private final AtomicInteger fetches = new AtomicInteger();
    private final MutableClock clock = new MutableClock(Instant.parse("2026-04-01T00:00:00Z"));

    /** A clock the test moves by hand. */
    static final class MutableClock extends Clock {
        private volatile Instant now;
        MutableClock(Instant now) { this.now = now; }
        void advance(Duration d) { now = now.plus(d); }
        @Override public java.time.ZoneId getZone() { return ZoneOffset.UTC; }
        @Override public Clock withZone(java.time.ZoneId zone) { return this; }
        @Override public Instant instant() { return now; }
    }

    @BeforeEach
    void setUp() throws Exception {
        KeyPairGenerator gen = KeyPairGenerator.getInstance("RSA");
        gen.initialize(2048);
        keyPair = gen.generateKeyPair();
        byte[] body = M.writeValueAsBytes(Map.of("keys",
                List.of(VerifierTest.jwkFor((RSAPublicKey) keyPair.getPublic(), "kid-known"))));
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.setExecutor(Executors.newCachedThreadPool());
        server.createContext("/" + REALM_ID + "/.well-known/jwks.json", exchange -> {
            fetches.incrementAndGet();
            try {
                Thread.sleep(50);
            } catch (InterruptedException ignored) {
                Thread.currentThread().interrupt();
            }
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
        return new Verifier(baseUrl, AUDIENCE, null, null, null, null, null, clock, null, null, null, null, REALM_ID);
    }

    private String sign(String kid) throws Exception {
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
        hdr.put("kid", kid);
        Base64.Encoder b = Base64.getUrlEncoder().withoutPadding();
        String signing = b.encodeToString(M.writeValueAsBytes(hdr)) + "." + b.encodeToString(M.writeValueAsBytes(claims));
        Signature sig = Signature.getInstance("SHA256withRSA");
        sig.initSign((RSAPrivateKey) keyPair.getPrivate());
        sig.update(signing.getBytes());
        return signing + "." + b.encodeToString(sig.sign());
    }

    private void assertUnknownKidConcurrently(Verifier v, int n) throws Exception {
        ExecutorService pool = Executors.newFixedThreadPool(n);
        try {
            List<Future<?>> fs = new ArrayList<>();
            for (int i = 0; i < n; i++) {
                String token = sign("kid-other");
                fs.add(pool.submit(() -> {
                    RealmException ex = assertThrows(RealmException.class, () -> v.verify(token));
                    assertEquals(ErrorCode.UNKNOWN_KID, ex.getCode());
                }));
            }
            for (Future<?> f : fs) f.get();
        } finally {
            pool.shutdownNow();
        }
    }

    @Test
    void unknownKidRefetchesAtMostOncePerFiveSeconds() throws Exception {
        Verifier v = newVerifier();
        v.verify(sign("kid-known"));
        assertEquals(1, fetches.get());

        assertUnknownKidConcurrently(v, 10);
        assertEquals(1, fetches.get(), "unknown kid inside the 5s window must not refetch");

        clock.advance(Duration.ofSeconds(5));
        assertUnknownKidConcurrently(v, 10);
        assertEquals(2, fetches.get(), "one shared refetch once the window has passed");
    }

    @Test
    void failedRefetchForAnUnknownKidStartsTheWindow() throws Exception {
        AtomicBoolean failing = serveFailing(false);
        Verifier v = newVerifier();
        v.verify(sign("kid-known"));
        failing.set(true);
        clock.advance(Duration.ofSeconds(5)); // the priming fetch started its own window

        assertFailsConcurrently(v, 10);
        assertEquals(2, fetches.get(), "10 unknown-kid verifies against a failing JWKS: one refetch");

        assertFailsConcurrently(v, 10);
        assertEquals(2, fetches.get(), "still inside the window");

        clock.advance(Duration.ofSeconds(5));
        assertFailsConcurrently(v, 10);
        assertEquals(3, fetches.get(), "one more fetch after the window");
    }

    /** Answers 500 while {@code failing} is set, else the key set. */
    private AtomicBoolean serveFailing(boolean initially) throws Exception {
        AtomicBoolean failing = new AtomicBoolean(initially);
        byte[] body = M.writeValueAsBytes(Map.of("keys",
                List.of(VerifierTest.jwkFor((RSAPublicKey) keyPair.getPublic(), "kid-known"))));
        server.removeContext("/" + REALM_ID + "/.well-known/jwks.json");
        server.createContext("/" + REALM_ID + "/.well-known/jwks.json", exchange -> {
            fetches.incrementAndGet();
            if (failing.get()) {
                exchange.sendResponseHeaders(500, -1);
                exchange.close();
                return;
            }
            exchange.sendResponseHeaders(200, body.length);
            try (OutputStream os = exchange.getResponseBody()) {
                os.write(body);
            }
        });
        return failing;
    }

    @Test
    void interruptedCallerIsNotTheRealmsFailedAttempt() throws Exception {
        Verifier v = newVerifier();
        Thread.currentThread().interrupt();
        try {
            assertThrows(RealmException.class, () -> v.verify(sign("kid-known")));
        } finally {
            Thread.interrupted();
        }
        v.verify(sign("kid-known"));
        assertEquals(1, fetches.get(), "the next caller fetches; nothing was recorded");
    }

    @Test
    void expiredSetRefetchIsNotGatedByTheWindow() throws Exception {
        AtomicBoolean failing = serveFailing(false);
        Verifier v = newVerifier();
        v.verify(sign("kid-known"));
        clock.advance(Duration.ofMinutes(11));
        failing.set(true);
        assertThrows(RealmException.class, () -> v.verify(sign("kid-known")));
        clock.advance(Duration.ofSeconds(1));
        failing.set(false);
        v.verify(sign("kid-known"));
        assertEquals(3, fetches.get());
    }

    @Test
    void absentSetRefetchIsNotGatedByTheWindow() throws Exception {
        AtomicBoolean failing = serveFailing(true);
        Verifier v = newVerifier();
        assertThrows(RealmException.class, () -> v.verify(sign("kid-known")));
        clock.advance(Duration.ofSeconds(1));
        failing.set(false);
        v.verify(sign("kid-known"));
        assertEquals(2, fetches.get());
    }

    private void assertFailsConcurrently(Verifier v, int n) throws Exception {
        ExecutorService pool = Executors.newFixedThreadPool(n);
        try {
            List<Future<?>> fs = new ArrayList<>();
            for (int i = 0; i < n; i++) {
                String token = sign("kid-other");
                fs.add(pool.submit(() -> {
                    assertThrows(RealmException.class, () -> v.verify(token));
                }));
            }
            for (Future<?> f : fs) f.get();
        } finally {
            pool.shutdownNow();
        }
    }
}

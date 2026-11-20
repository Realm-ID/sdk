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
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** SPEC §2: callers that need a JWKS fetch share ONE in-flight fetch and receive its outcome. */
class JwksFlightTest {

    private static final String REALM_ID = "01HXYZREALM";
    private static final String AUDIENCE = "example.com";
    private static final ObjectMapper M = new ObjectMapper();

    private HttpServer server;
    private String baseUrl;
    private KeyPair keyPair;
    private final AtomicInteger fetches = new AtomicInteger();
    private final Semaphore started = new Semaphore(0);
    private final AtomicReference<CountDownLatch> gate = new AtomicReference<>(new CountDownLatch(1));
    private final AtomicBoolean failing = new AtomicBoolean();
    private final KidRefetchTest.MutableClock clock =
            new KidRefetchTest.MutableClock(Instant.parse("2026-04-01T00:00:00Z"));
    private ExecutorService pool;

    @BeforeEach
    void setUp() throws Exception {
        KeyPairGenerator gen = KeyPairGenerator.getInstance("RSA");
        gen.initialize(2048);
        keyPair = gen.generateKeyPair();
        byte[] body = M.writeValueAsBytes(Map.of("keys",
                List.of(VerifierTest.jwkFor((RSAPublicKey) keyPair.getPublic(), "kid-known"))));
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.setExecutor(Executors.newCachedThreadPool());
        server.createContext("/", exchange -> {
            fetches.incrementAndGet();
            started.release();
            try {
                gate.get().await();
            } catch (InterruptedException ignored) {
                Thread.currentThread().interrupt();
            }
            if (failing.get()) {
                exchange.sendResponseHeaders(500, -1);
                exchange.close();
                return;
            }
            exchange.getResponseHeaders().add("content-type", "application/json");
            exchange.sendResponseHeaders(200, body.length);
            try (OutputStream os = exchange.getResponseBody()) {
                os.write(body);
            }
        });
        server.start();
        baseUrl = "http://127.0.0.1:" + server.getAddress().getPort();
        pool = Executors.newCachedThreadPool();
    }

    @AfterEach
    void tearDown() {
        gate.get().countDown();
        pool.shutdownNow();
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

    private Future<Throwable> call(Verifier v, String token) {
        return pool.submit(() -> {
            try {
                v.verify(token);
                return null;
            } catch (Throwable t) {
                return t;
            }
        });
    }

    private void awaitFetchStart() throws Exception {
        assertTrue(started.tryAcquire(5, TimeUnit.SECONDS), "no fetch reached the server");
    }

    /** Gives the other callers time to reach the flight. */
    private void settle() throws Exception {
        Thread.sleep(300);
    }

    @Test
    void concurrentCallersShareOneFetch() throws Exception {
        Verifier v = newVerifier();
        String token = sign("kid-known");
        List<Future<Throwable>> fs = new ArrayList<>();
        for (int i = 0; i < 8; i++) fs.add(call(v, token));
        awaitFetchStart();
        settle();
        gate.get().countDown();
        for (Future<Throwable> f : fs) assertNull(f.get(10, TimeUnit.SECONDS));
        assertEquals(1, fetches.get());
    }

    @Test
    void failureIsSharedAndNotRetriedInTheWindow() throws Exception {
        failing.set(true);
        Verifier v = newVerifier();
        String token = sign("kid-known");
        List<Future<Throwable>> fs = new ArrayList<>();
        for (int i = 0; i < 6; i++) fs.add(call(v, token));
        awaitFetchStart();
        settle();
        gate.get().countDown();
        for (Future<Throwable> f : fs) {
            Throwable t = f.get(10, TimeUnit.SECONDS);
            assertTrue(t instanceof RealmException re && re.getCode() == ErrorCode.JWKS_FETCH_FAILED, String.valueOf(t));
        }
        assertEquals(1, fetches.get());
    }

    /** A fetch that dies on an Error (not an Exception) must still release its waiters and the realm. */
    @Test
    void fetchThatDiesOnAnErrorDoesNotStrandWaiters() throws Exception {
        AtomicBoolean dying = new AtomicBoolean(true);
        ObjectMapper dyingMapper = new ObjectMapper() {
            @Override
            public com.fasterxml.jackson.databind.JsonNode readTree(String content)
                    throws com.fasterxml.jackson.core.JsonProcessingException {
                if (dying.get()) throw new NoClassDefFoundError("simulated");
                return super.readTree(content);
            }
        };
        Verifier v = new Verifier(baseUrl, AUDIENCE, null, null, dyingMapper, null, null, clock, null, null, null,
                null, REALM_ID);
        gate.get().countDown();
        String token = sign("kid-known");
        List<Future<Throwable>> fs = new ArrayList<>();
        for (int i = 0; i < 3; i++) fs.add(call(v, token));
        for (Future<Throwable> f : fs) {
            Throwable t = f.get(5, TimeUnit.SECONDS); // a stranded waiter times out here
            assertTrue(t instanceof RealmException re && re.getCode() == ErrorCode.JWKS_FETCH_FAILED, String.valueOf(t));
        }
        dying.set(false);
        assertNull(call(v, token).get(5, TimeUnit.SECONDS), "a later verify must start a new flight");
    }

    /** The fetch deadline covers the body, not just the headers: a stall mid-body must fail, not hang. */
    @Test
    void stalledBodyFailsWithinTheFetchBound() throws Exception {
        CountDownLatch release = new CountDownLatch(1);
        server.removeContext("/");
        server.createContext("/", exchange -> {
            fetches.incrementAndGet();
            exchange.getResponseHeaders().add("content-type", "application/json");
            exchange.sendResponseHeaders(200, 10_000);
            OutputStream os = exchange.getResponseBody();
            os.write("{\"keys\":".getBytes());
            os.flush();
            try {
                release.await(60, TimeUnit.SECONDS);
            } catch (InterruptedException ignored) {
                Thread.currentThread().interrupt();
            }
            exchange.close();
        });
        Verifier v = newVerifier();
        String token = sign("kid-known");
        Future<Throwable> a = call(v, token);
        Future<Throwable> b = call(v, token);
        try {
            // The bound is 5s; allow 2x plus slack. A hang surfaces as TimeoutException here.
            for (Future<Throwable> f : List.of(a, b)) {
                Throwable t = f.get(12, TimeUnit.SECONDS);
                assertTrue(t instanceof RealmException re && re.getCode() == ErrorCode.JWKS_FETCH_FAILED,
                        String.valueOf(t));
            }
        } finally {
            release.countDown();
        }
    }

    @Test
    void interruptedLeaderDoesNotFailWaiters() throws Exception {
        Verifier v = newVerifier();
        String token = sign("kid-known");
        CountDownLatch leaderDone = new CountDownLatch(1);
        AtomicReference<Throwable> leaderErr = new AtomicReference<>();
        AtomicBoolean leaderFlag = new AtomicBoolean();
        Thread leader = new Thread(() -> {
            try {
                v.verify(token);
            } catch (Throwable t) {
                leaderErr.set(t);
            }
            leaderFlag.set(Thread.currentThread().isInterrupted());
            leaderDone.countDown();
        });
        leader.start();
        awaitFetchStart();
        List<Future<Throwable>> others = new ArrayList<>();
        for (int i = 0; i < 4; i++) others.add(call(v, token));
        settle();
        leader.interrupt();
        assertTrue(leaderDone.await(5, TimeUnit.SECONDS), "the interrupted caller must return at once");
        assertTrue(leaderErr.get() instanceof RealmException, String.valueOf(leaderErr.get()));
        assertTrue(leaderFlag.get(), "the interrupt is handed back");
        gate.get().countDown();
        for (Future<Throwable> f : others) assertNull(f.get(10, TimeUnit.SECONDS));
        assertEquals(1, fetches.get());
    }

    @Test
    void interruptedWaiterReturnsAloneAndRecordsNothing() throws Exception {
        Verifier v = newVerifier();
        String token = sign("kid-known");
        Future<Throwable> first = call(v, token);
        awaitFetchStart();
        CountDownLatch done = new CountDownLatch(1);
        AtomicReference<Throwable> err = new AtomicReference<>();
        Thread waiter = new Thread(() -> {
            try {
                v.verify(token);
            } catch (Throwable t) {
                err.set(t);
            }
            done.countDown();
        });
        waiter.start();
        settle();
        waiter.interrupt();
        assertTrue(done.await(5, TimeUnit.SECONDS));
        assertTrue(err.get() instanceof RealmException);
        gate.get().countDown();
        assertNull(first.get(10, TimeUnit.SECONDS));
        assertEquals(1, fetches.get());
    }

    @Test
    void interruptedBeforeAnyFetchStartsNothing() throws Exception {
        Verifier v = newVerifier();
        String token = sign("kid-known");
        Thread.currentThread().interrupt();
        try {
            assertThrows(RealmException.class, () -> v.verify(token));
        } finally {
            Thread.interrupted();
        }
        assertEquals(0, fetches.get());
    }

    @Test
    void unknownKidRefetchOfAFreshSetIsShared() throws Exception {
        gate.get().countDown();
        Verifier v = newVerifier();
        v.verify(sign("kid-known"));
        started.drainPermits();
        clock.advance(Duration.ofSeconds(6));
        gate.set(new CountDownLatch(1));
        String other = sign("kid-other");
        List<Future<Throwable>> fs = new ArrayList<>();
        for (int i = 0; i < 5; i++) fs.add(call(v, other));
        awaitFetchStart();
        settle();
        gate.get().countDown();
        for (Future<Throwable> f : fs) {
            Throwable t = f.get(10, TimeUnit.SECONDS);
            assertTrue(t instanceof RealmException re && re.getCode() == ErrorCode.UNKNOWN_KID, String.valueOf(t));
        }
        assertEquals(2, fetches.get());
    }

    @Test
    void freshFetchAfterTheWindow() throws Exception {
        gate.get().countDown();
        Verifier v = newVerifier();
        v.verify(sign("kid-known"));
        String other = sign("kid-other");
        clock.advance(Duration.ofSeconds(2));
        assertThrows(RealmException.class, () -> v.verify(other));
        assertEquals(1, fetches.get(), "inside the window: no new fetch");
        clock.advance(Duration.ofSeconds(4));
        assertThrows(RealmException.class, () -> v.verify(other));
        assertEquals(2, fetches.get(), "after the window: one fresh fetch");
    }
}

package dev.realmid.sdk.auth;

import dev.realmid.sdk.ErrorCode;
import dev.realmid.sdk.FakeServer;
import dev.realmid.sdk.Realm;
import dev.realmid.sdk.RealmException;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * TokenManager — SPEC §4.2.1. Mirrors the Go {@code token_manager_test.go}
 * suite: cache/refresh, persist-before-return sink, sink-failure retry,
 * refresh_invalid terminal, and concurrent single-flight.
 *
 * <p>{@code POST /auth/login} serves the platform bootstrap bearer (the
 * manager wraps {@code AuthClient.token}, which presents the platform token +
 * refresh-in-body, mirroring the Go reference). {@code POST /auth/token} is the
 * user-refresh endpoint under test; its handler counts calls and echoes a
 * rotated token pair.
 */
class TokenManagerTest {
    private FakeServer fs;
    private Realm realm;
    private final AtomicInteger tokenCalls = new AtomicInteger();

    @BeforeEach
    void setUp() throws IOException {
        fs = new FakeServer();
        fs.on("POST /auth/login", (ex, body) -> FakeServer.Reply.json(200, Map.of(
                "access_token", "atok-plat", "refresh_token", "rtok-plat",
                "expires_in", 3600, "subject_type", "platform")));
        realm = Realm.builder()
                .realmId("01HREALM")
                .apiKey("rk_live_test")
                .baseUrl(fs.baseUrl)
                .audience("acme.test")
                .build();
    }

    @AfterEach
    void tearDown() { fs.close(); }

    private void rotatingTokenHandler() {
        fs.on("POST /auth/token", (ex, body) -> {
            int n = tokenCalls.incrementAndGet();
            return FakeServer.Reply.json(200, Map.of(
                    "access_token", "atok-user-" + n,
                    "refresh_token", "rtok-user-" + n,
                    "expires_in", 3600, "tenant_id", "tnt-1", "role", "member"));
        });
    }

    @Test
    void cacheThenRefresh() {
        rotatingTokenHandler();
        long[] nowMs = { 0L };
        TokenManager mgr = realm.auth().newTokenManager("rtok-seed",
                new TokenManagerOptions().tenantId("tnt-1").clock(() -> nowMs[0]));

        assertEquals("atok-user-1", mgr.accessToken());
        assertEquals(1, tokenCalls.get());
        // Cache hit — no extra /auth/token (token has full 3600s of life).
        assertEquals("atok-user-1", mgr.accessToken());
        assertEquals(1, tokenCalls.get());
        // Advance to within the 60s lead window → refresh, presenting the
        // rotated token.
        nowMs[0] = 3600_000L - 15_000L;
        assertEquals("atok-user-2", mgr.accessToken());
        assertEquals(2, tokenCalls.get());
        assertEquals("rtok-user-2", mgr.refreshToken());
    }

    @Test
    void sinkPersistsBeforeReturn() {
        rotatingTokenHandler();
        AtomicReference<String> persisted = new AtomicReference<>();
        TokenManager mgr = realm.auth().newTokenManager("rtok-seed",
                new TokenManagerOptions().tenantId("tnt-1")
                        .refreshSink(persisted::set));
        mgr.accessToken();
        assertEquals("rtok-user-1", persisted.get());
    }

    @Test
    void sinkFailureBlocksThenRetrySucceeds() {
        rotatingTokenHandler();
        AtomicInteger sinkCalls = new AtomicInteger();
        TokenManager mgr = realm.auth().newTokenManager("rtok-seed",
                new TokenManagerOptions().tenantId("tnt-1")
                        .refreshSink(t -> {
                            if (sinkCalls.incrementAndGet() == 1) {
                                throw new RuntimeException("disk full");
                            }
                        }));
        // First acquisition: server rotated to rtok-user-1 but the sink fails →
        // accessToken throws, nothing cached.
        assertThrows(RealmException.class, mgr::accessToken);
        // The rotated token was committed pre-sink so a retry presents the live
        // (unconsumed) token.
        assertEquals("rtok-user-1", mgr.refreshToken());
        // Retry: presents rtok-user-1, server rotates to rtok-user-2, sink ok.
        assertEquals("atok-user-2", mgr.accessToken());
        assertEquals(2, tokenCalls.get());
    }

    @Test
    void refreshInvalidIsTerminal() {
        fs.on("POST /auth/token", (ex, body) -> {
            tokenCalls.incrementAndGet();
            return FakeServer.Reply.json(401, Map.of(
                    "code", "refresh_invalid",
                    "message", "refresh token is invalid, expired, or revoked"));
        });
        TokenManager mgr = realm.auth().newTokenManager("rtok-dead",
                new TokenManagerOptions().tenantId("tnt-1"));
        RealmException ex = assertThrows(RealmException.class, mgr::accessToken);
        assertEquals(ErrorCode.REFRESH_INVALID, ex.getCode());
        assertEquals(1, tokenCalls.get(), "must not retry or fall back");
    }

    @Test
    void refreshInvalidViaNestedEnvelope() {
        // The issuer wraps errors as {"error":{"code:...}}; confirm the decoder
        // reads the nested error.code.
        fs.on("POST /auth/token", (ex, body) -> FakeServer.Reply.json(401, Map.of(
                "error", Map.of("code", "refresh_invalid", "message", "revoked"))));
        TokenManager mgr = realm.auth().newTokenManager("rtok-dead",
                new TokenManagerOptions().tenantId("tnt-1"));
        RealmException ex = assertThrows(RealmException.class, mgr::accessToken);
        assertEquals(ErrorCode.REFRESH_INVALID, ex.getCode());
    }

    @Test
    void concurrentSingleFlight() throws InterruptedException {
        fs.on("POST /auth/token", (ex, body) -> {
            int n = tokenCalls.incrementAndGet();
            try { Thread.sleep(40); } catch (InterruptedException ignored) {}
            return FakeServer.Reply.json(200, Map.of(
                    "access_token", "atok-user-" + n,
                    "refresh_token", "rtok-user-" + n,
                    "expires_in", 3600, "tenant_id", "tnt-1"));
        });
        TokenManager mgr = realm.auth().newTokenManager("rtok-seed",
                new TokenManagerOptions().tenantId("tnt-1"));

        final int n = 12;
        CountDownLatch ready = new CountDownLatch(n);
        CountDownLatch go = new CountDownLatch(1);
        AtomicReference<Throwable> failure = new AtomicReference<>();
        Thread[] threads = new Thread[n];
        for (int i = 0; i < n; i++) {
            threads[i] = new Thread(() -> {
                ready.countDown();
                try {
                    go.await();
                    mgr.accessToken();
                } catch (Throwable t) {
                    failure.set(t);
                }
            });
            threads[i].start();
        }
        ready.await();
        go.countDown();
        for (Thread t : threads) t.join();

        assertTrue(failure.get() == null, "concurrent accessToken failed: " + failure.get());
        assertEquals(1, tokenCalls.get(), "single-flight: exactly one /auth/token call");
    }
}

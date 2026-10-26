package dev.realmid.sdk.platformtoken;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.realmid.sdk.ErrorCode;
import dev.realmid.sdk.FakeServer;
import dev.realmid.sdk.RealmException;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.net.http.HttpClient;
import java.time.Clock;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.IntFunction;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * SPEC section 4.0.1, "Replayed-assertion retry": a workload login answered
 * 409 assertion_replayed is retried with a freshly fetched credential after
 * 1 s then 2 s, three attempts in all.
 */
class PlatformTokenManagerReplayTest {
    private FakeServer fs;
    private final List<String> subjects = new CopyOnWriteArrayList<>();
    private final List<Duration> waits = new ArrayList<>();
    private final AtomicInteger fetches = new AtomicInteger();

    @BeforeEach void setUp() throws IOException { fs = new FakeServer(); }
    @AfterEach void tearDown() { fs.close(); }

    private void serve(IntFunction<FakeServer.Reply> replies) {
        fs.on("POST /auth/login", (ex, body) -> {
            try {
                JsonNode n = new ObjectMapper().readTree(body);
                JsonNode s = n.has("subject_token") ? n.get("subject_token") : n.get("api_key");
                subjects.add(s.asText());
            } catch (IOException e) { throw new RuntimeException(e); }
            return replies.apply(subjects.size());
        });
    }

    private static FakeServer.Reply refusal(int status, String code) {
        return FakeServer.Reply.json(status, Map.of("error", Map.of(
                "code", code, "message", "assertion already used; fetch a fresh one and retry")));
    }

    private static FakeServer.Reply ok() {
        return FakeServer.Reply.json(200, Map.of("access_token", "at", "expires_in", 300, "subject_type", "platform"));
    }

    private CredentialSource workload() {
        return () -> Credential.ofWorkloadToken("wl-" + fetches.incrementAndGet());
    }

    private PlatformTokenManager manager(CredentialSource cs, PlatformTokenManager.Sleeper sleeper) {
        return new PlatformTokenManager(cs, fs.baseUrl, HttpClient.newHttpClient(), new ObjectMapper(), null,
                Clock.systemUTC(), Duration.ofSeconds(30), null, sleeper);
    }

    private PlatformTokenManager fakeSleep(CredentialSource cs) {
        return manager(cs, waits::add);
    }

    @Test
    void replayedIsRetriedWithNewCredentialThenSucceeds() {
        serve(n -> n <= 2 ? refusal(409, "assertion_replayed") : ok());
        assertEquals("at", fakeSleep(workload()).getToken());
        assertEquals(List.of("wl-1", "wl-2", "wl-3"), subjects);
        assertEquals(3, fetches.get());
        assertEquals(List.of(Duration.ofSeconds(1), Duration.ofSeconds(2)), waits);
    }

    @Test
    void threeFailuresReturnLastErrorUnchanged() {
        serve(n -> refusal(409, "assertion_replayed"));
        RealmException e = assertThrows(RealmException.class, () -> fakeSleep(workload()).getToken());
        assertEquals(ErrorCode.ASSERTION_REPLAYED, e.getCode());
        assertEquals(409, e.getHttpStatus());
        assertEquals(3, subjects.size());
        assertEquals(2, waits.size());
        assertNotEquals(subjects.get(0), subjects.get(1));
    }

    @Test
    void staticApiKeyIsNeverRetried() {
        serve(n -> refusal(409, "assertion_replayed"));
        assertThrows(RealmException.class, () -> fakeSleep(CredentialSources.staticApiKey("rk_live_x")).getToken());
        assertEquals(1, subjects.size());
        assertTrue(waits.isEmpty());
    }

    @Test
    void otherCodesAndStatusesAreNeverRetried() {
        int[] statuses = {409, 401, 401};
        String[] codes = {"conflict", "assertion_replayed", "unauthorized"};
        for (int i = 0; i < statuses.length; i++) {
            subjects.clear();
            waits.clear();
            int st = statuses[i];
            String code = codes[i];
            serve(n -> refusal(st, code));
            assertThrows(RealmException.class, () -> fakeSleep(workload()).getToken());
            assertEquals(1, subjects.size(), "status " + st + " code " + code);
            assertTrue(waits.isEmpty());
        }
    }

    @Test
    void interruptDuringRealBackoffReturnsPromptly() {
        serve(n -> refusal(409, "assertion_replayed"));
        Thread caller = Thread.currentThread();
        Thread t = new Thread(() -> {
            try { Thread.sleep(50); } catch (InterruptedException ignored) { }
            caller.interrupt();
        });
        t.start();
        long start = System.nanoTime();
        RealmException e = assertThrows(RealmException.class,
                () -> manager(workload(), PlatformTokenManager.Sleeper.REAL).getToken());
        long ms = (System.nanoTime() - start) / 1_000_000;
        assertTrue(Thread.interrupted(), "interrupt flag must be restored");
        assertTrue(ms < 800, "a 1s backoff must be abandoned on interrupt, took " + ms);
        assertEquals(ErrorCode.NETWORK, e.getCode());
        assertEquals(1, subjects.size());
    }
}

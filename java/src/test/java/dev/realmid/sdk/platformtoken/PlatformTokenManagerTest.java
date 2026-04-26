package dev.realmid.sdk.platformtoken;

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
import java.time.Instant;
import java.time.ZoneId;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;

class PlatformTokenManagerTest {
    private FakeServer fs;

    @BeforeEach void setUp() throws IOException { fs = new FakeServer(); }
    @AfterEach void tearDown() { fs.close(); }

    @Test
    void mintAndCacheHit() {
        AtomicInteger calls = new AtomicInteger();
        fs.on("POST /auth/platform-token", (ex, body) -> {
            calls.incrementAndGet();
            return FakeServer.Reply.json(200, Map.of(
                    "platform_token", "pt-" + calls.get(),
                    "expires_in", 300));
        });
        var ptm = new PlatformTokenManager("rk_live_secret", fs.baseUrl,
                HttpClient.newHttpClient(), new ObjectMapper(), null,
                Clock.systemUTC(), Duration.ofSeconds(30));

        String t1 = ptm.getToken();
        String t2 = ptm.getToken();
        assertEquals(1, calls.get());
        assertEquals("pt-1", t1);
        assertSame(t1, t2);
    }

    @Test
    void refreshOnExpiry() {
        AtomicInteger calls = new AtomicInteger();
        fs.on("POST /auth/platform-token", (ex, body) -> {
            calls.incrementAndGet();
            return FakeServer.Reply.json(200, Map.of(
                    "platform_token", "pt-" + calls.get(),
                    "expires_in", 60));
        });
        // Clock that jumps forward.
        long[] nowMs = { Instant.parse("2024-01-01T00:00:00Z").toEpochMilli() };
        Clock c = Clock.fixed(Instant.ofEpochMilli(nowMs[0]), ZoneId.of("UTC"));
        var ptm = new PlatformTokenManager("rk", fs.baseUrl,
                HttpClient.newHttpClient(), new ObjectMapper(), null,
                new Clock() {
                    @Override public ZoneId getZone() { return ZoneId.of("UTC"); }
                    @Override public Clock withZone(ZoneId z) { return this; }
                    @Override public Instant instant() { return Instant.ofEpochMilli(nowMs[0]); }
                    @Override public long millis() { return nowMs[0]; }
                },
                Duration.ofSeconds(30));
        String first = ptm.getToken();
        // Advance past skew.
        nowMs[0] += 50_000;
        String second = ptm.getToken();
        assertEquals(2, calls.get());
        assertNotEquals(first, second);
    }

    @Test
    void unauthorizedSurfaces() {
        fs.on("POST /auth/platform-token", (ex, body) -> FakeServer.Reply.json(401,
                Map.of("error", Map.of("code", "unauthorized", "message", "bad key"))));
        var ptm = new PlatformTokenManager("rk", fs.baseUrl,
                HttpClient.newHttpClient(), new ObjectMapper(), null,
                Clock.systemUTC(), Duration.ofSeconds(30));
        RealmException ex = assertThrows(RealmException.class, ptm::getToken);
        assertEquals(ErrorCode.UNAUTHORIZED, ex.getCode());
        assertEquals(401, ex.getHttpStatus());
    }
}

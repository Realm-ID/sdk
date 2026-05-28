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

/**
 * Two-endpoint platform session (SPEC §4.0, ADR-051). First acquire goes
 * through {@code POST /auth/login {grant_type:"platform_api_key"}}; subsequent
 * refreshes go through {@code POST /auth/token} with the refresh token as the
 * bearer.
 */
class PlatformTokenManagerTest {
    private FakeServer fs;

    @BeforeEach void setUp() throws IOException { fs = new FakeServer(); }
    @AfterEach void tearDown() { fs.close(); }

    private PlatformTokenManager manager(Clock clock) {
        return new PlatformTokenManager("rk_live_secret", fs.baseUrl,
                HttpClient.newHttpClient(), new ObjectMapper(), null,
                clock, Duration.ofSeconds(30));
    }

    private static Clock mutableClock(long[] nowMs) {
        return new Clock() {
            @Override public ZoneId getZone() { return ZoneId.of("UTC"); }
            @Override public Clock withZone(ZoneId z) { return this; }
            @Override public Instant instant() { return Instant.ofEpochMilli(nowMs[0]); }
            @Override public long millis() { return nowMs[0]; }
        };
    }

    @Test
    void loginAndCacheHit() {
        AtomicInteger calls = new AtomicInteger();
        fs.on("POST /auth/login", (ex, body) -> {
            calls.incrementAndGet();
            return FakeServer.Reply.json(200, Map.of(
                    "access_token", "pt-" + calls.get(),
                    "refresh_token", "rt-" + calls.get(),
                    "expires_in", 300,
                    "subject_type", "platform"));
        });
        var ptm = manager(Clock.systemUTC());

        String t1 = ptm.getToken();
        String t2 = ptm.getToken();
        assertEquals(1, calls.get());
        assertEquals("pt-1", t1);
        assertSame(t1, t2);
    }

    @Test
    void refreshOnExpiryUsesAuthToken() {
        AtomicInteger logins = new AtomicInteger();
        AtomicInteger refreshes = new AtomicInteger();
        fs.on("POST /auth/login", (ex, body) -> {
            logins.incrementAndGet();
            return FakeServer.Reply.json(200, Map.of(
                    "access_token", "pt-login", "refresh_token", "rt-1",
                    "expires_in", 60, "subject_type", "platform"));
        });
        fs.on("POST /auth/token", (ex, body) -> {
            refreshes.incrementAndGet();
            return FakeServer.Reply.json(200, Map.of(
                    "access_token", "pt-refresh-" + refreshes.get(), "refresh_token", "rt-2",
                    "expires_in", 60, "subject_type", "platform"));
        });
        long[] nowMs = { Instant.parse("2024-01-01T00:00:00Z").toEpochMilli() };
        var ptm = manager(mutableClock(nowMs));
        String first = ptm.getToken();
        // Advance past skew so the cached access token is stale.
        nowMs[0] += 50_000;
        String second = ptm.getToken();
        assertEquals(1, logins.get(), "only one initial login");
        assertEquals(1, refreshes.get(), "stale token refreshes via /auth/token");
        assertNotEquals(first, second);
        assertEquals("pt-login", first);
        assertEquals("pt-refresh-1", second);
    }

    @Test
    void refreshTokenPresentedAsBearer() {
        fs.on("POST /auth/login", (ex, body) -> FakeServer.Reply.json(200, Map.of(
                "access_token", "pt-login", "refresh_token", "rt-seed",
                "expires_in", 300, "subject_type", "platform")));
        fs.on("POST /auth/token", (ex, body) -> {
            // The refresh token must be the bearer on /auth/token.
            assertEquals("Bearer rt-seed", fs.last().header("authorization"));
            return FakeServer.Reply.json(200, Map.of(
                    "access_token", "pt-refresh", "refresh_token", "rt-next",
                    "expires_in", 300, "subject_type", "platform"));
        });
        var ptm = manager(Clock.systemUTC());
        ptm.getToken();                 // login
        ptm.invalidate();               // drop access token, keep refresh
        assertEquals("pt-refresh", ptm.getToken());
    }

    @Test
    void fallsBackToLoginWhenAuthTokenRejects() {
        AtomicInteger logins = new AtomicInteger();
        fs.on("POST /auth/login", (ex, body) -> {
            int n = logins.incrementAndGet();
            return FakeServer.Reply.json(200, Map.of(
                    "access_token", "pt-login-" + n, "refresh_token", "rt-" + n,
                    "expires_in", 300, "subject_type", "platform"));
        });
        fs.on("POST /auth/token", (ex, body) -> FakeServer.Reply.json(401,
                Map.of("error", Map.of("code", "unauthorized", "message", "rotated away"))));
        var ptm = manager(Clock.systemUTC());
        ptm.getToken();      // login #1
        ptm.invalidate();    // keep refresh → next acquire tries /auth/token, 401s, re-logs in
        String tok = ptm.getToken();
        assertEquals(2, logins.get(), "401 on /auth/token falls back to a fresh login");
        assertEquals("pt-login-2", tok);
    }

    @Test
    void unauthorizedLoginSurfaces() {
        fs.on("POST /auth/login", (ex, body) -> FakeServer.Reply.json(401,
                Map.of("error", Map.of("code", "unauthorized", "message", "bad key"))));
        var ptm = manager(Clock.systemUTC());
        RealmException ex = assertThrows(RealmException.class, ptm::getToken);
        assertEquals(ErrorCode.UNAUTHORIZED, ex.getCode());
        assertEquals(401, ex.getHttpStatus());
    }
}

package dev.realmid.sdk.origins;

import dev.realmid.sdk.ErrorCode;
import dev.realmid.sdk.FakeServer;
import dev.realmid.sdk.Realm;
import dev.realmid.sdk.RealmException;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.net.http.HttpClient;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class OriginsTest {
    private static final String REALM_ID = "01HREALM";

    private FakeServer fs;

    @BeforeEach
    void setUp() throws IOException {
        fs = new FakeServer();
    }

    @AfterEach
    void tearDown() { fs.close(); }

    private Realm realm(Clock clock) {
        Realm.Builder b = Realm.builder()
                .realmId(REALM_ID)
                .apiKey("rk")
                .baseUrl(fs.baseUrl)
                .audience("acme.test")
                .httpClient(HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1).build());
        if (clock != null) b = b.clock(clock);
        return b.build();
    }

    private static Map<String, Object> page(List<Map<String, Object>> items, String cursor) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("items", items);
        m.put("next_cursor", cursor);
        return m;
    }

    @Test
    void normalizeStripsSchemePortPath() {
        assertEquals("app.example.com", OriginsClient.normalize("https://App.Example.com:8443/foo"));
        assertEquals("localhost", OriginsClient.normalize("http://localhost:5173"));
        assertEquals("acme.com", OriginsClient.normalize("ACME.com"));
        assertEquals("", OriginsClient.normalize(null));
        assertEquals("", OriginsClient.normalize(""));
    }

    @Test
    void validateCachesAcrossCalls() {
        AtomicInteger mintCount = new AtomicInteger();
        AtomicInteger listCount = new AtomicInteger();
        fs.on("POST /auth/login", (ex, body) -> {
            mintCount.incrementAndGet();
            return FakeServer.Reply.json(200, Map.of("access_token", "pt", "refresh_token", "rt", "expires_in", 300, "subject_type", "platform"));
        });
        fs.on("GET /platforms/" + REALM_ID + "/origins", (ex, body) -> {
            listCount.incrementAndGet();
            return FakeServer.Reply.json(200, page(List.of(
                    Map.of("id", "o1", "domain", "app.acme.com", "entity_type", "tenant", "entity_id", "t1"),
                    Map.of("id", "o2", "domain", "auth.acme.com", "entity_type", "realm", "entity_id", REALM_ID)
            ), null));
        });
        Realm r = realm(null);
        assertTrue(r.origins().validate(REALM_ID, "https://app.acme.com"));
        assertTrue(r.origins().validate(REALM_ID, "https://AUTH.acme.com:443"));
        assertFalse(r.origins().validate(REALM_ID, "https://other.com"));
        assertEquals(1, listCount.get(), "subsequent validates serve from cache");
    }

    @Test
    void ttlExpiryRefetches() {
        AtomicInteger listCount = new AtomicInteger();
        fs.on("POST /auth/login", (ex, body) ->
                FakeServer.Reply.json(200, Map.of("access_token", "pt", "refresh_token", "rt", "expires_in", 300, "subject_type", "platform")));
        // After the platform token's 300s lifetime, the session refreshes via
        // POST /auth/token (ADR-051 two-endpoint flow).
        fs.on("POST /auth/token", (ex, body) ->
                FakeServer.Reply.json(200, Map.of("access_token", "pt2", "refresh_token", "rt", "expires_in", 300, "subject_type", "platform")));
        fs.on("GET /platforms/" + REALM_ID + "/origins", (ex, body) -> {
            listCount.incrementAndGet();
            return FakeServer.Reply.json(200, page(List.of(
                    Map.of("id", "o1", "domain", "app.acme.com", "entity_type", "tenant", "entity_id", "t1")
            ), null));
        });
        MutableClock clock = new MutableClock(Instant.ofEpochSecond(1_000_000));
        Realm r = realm(clock);

        assertTrue(r.origins().validate(REALM_ID, "https://app.acme.com"));
        clock.advance(java.time.Duration.ofMinutes(4));
        assertTrue(r.origins().validate(REALM_ID, "https://app.acme.com"));
        assertEquals(1, listCount.get());
        clock.advance(java.time.Duration.ofMinutes(2));
        assertTrue(r.origins().validate(REALM_ID, "https://app.acme.com"));
        assertEquals(2, listCount.get());
    }

    @Test
    void refreshOn401() {
        // First acquire = POST /auth/login; a 401 on the resource call
        // invalidates the cached access token and the retry re-mints from the
        // credential — ADR-089 removed the /auth/token leg for this identity,
        // so the retry is a second login, not a refresh.
        AtomicInteger loginCount = new AtomicInteger();
        AtomicInteger refreshCount = new AtomicInteger();
        AtomicInteger listCount = new AtomicInteger();
        fs.on("POST /auth/login", (ex, body) -> {
            loginCount.incrementAndGet();
            return FakeServer.Reply.json(200, Map.of(
                    "access_token", "pt-login-" + loginCount.get(),
                    "expires_in", 300, "subject_type", "platform"));
        });
        fs.on("POST /auth/token", (ex, body) -> {
            refreshCount.incrementAndGet();
            return FakeServer.Reply.json(200, Map.of(
                    "access_token", "pt-refreshed", "refresh_token", "rt-2",
                    "expires_in", 300, "subject_type", "platform"));
        });
        fs.on("GET /platforms/" + REALM_ID + "/origins", (ex, body) -> {
            int n = listCount.incrementAndGet();
            if (n == 1) {
                return FakeServer.Reply.json(401, Map.of(
                        "error", Map.of("code", "unauthorized", "message", "stale")));
            }
            return FakeServer.Reply.json(200, page(List.of(
                    Map.of("id", "o1", "domain", "app.acme.com", "entity_type", "tenant", "entity_id", "t1")
            ), null));
        });
        Realm r = realm(null);
        assertTrue(r.origins().validate(REALM_ID, "https://app.acme.com"));
        assertEquals(2, loginCount.get(), "401 forces a re-mint via /auth/login");
        assertEquals(0, refreshCount.get(), "ADR-089: /auth/token must not be used");
    }

    @Test
    void persistentUnauthorizedSurfaces() {
        fs.on("POST /auth/login", (ex, body) ->
                FakeServer.Reply.json(200, Map.of("access_token", "pt", "refresh_token", "rt", "expires_in", 300, "subject_type", "platform")));
        fs.on("POST /auth/token", (ex, body) ->
                FakeServer.Reply.json(200, Map.of("access_token", "pt2", "refresh_token", "rt", "expires_in", 300, "subject_type", "platform")));
        fs.on("GET /platforms/" + REALM_ID + "/origins", (ex, body) ->
                FakeServer.Reply.json(401, Map.of(
                        "error", Map.of("code", "unauthorized", "message", "nope"))));
        Realm r = realm(null);
        RealmException ex = assertThrows(RealmException.class,
                () -> r.origins().validate(REALM_ID, "https://app.acme.com"));
        assertEquals(ErrorCode.UNAUTHORIZED, ex.getCode());
    }

    @Test
    void listPaginates() {
        fs.on("POST /auth/login", (ex, body) ->
                FakeServer.Reply.json(200, Map.of("access_token", "pt", "refresh_token", "rt", "expires_in", 300, "subject_type", "platform")));
        AtomicInteger calls = new AtomicInteger();
        fs.on("GET /platforms/" + REALM_ID + "/origins", (ex, body) -> {
            int n = calls.incrementAndGet();
            if (n == 1) {
                return FakeServer.Reply.json(200, page(List.of(
                        Map.of("id", "o1", "domain", "a.com", "entity_type", "realm", "entity_id", REALM_ID)
                ), "c1"));
            }
            return FakeServer.Reply.json(200, page(List.of(
                    Map.of("id", "o2", "domain", "b.com", "entity_type", "tenant", "entity_id", "t1")
            ), null));
        });
        Realm r = realm(null);
        List<String> got = r.origins().list(REALM_ID).stream().map(OriginsClient.Origin::domain).toList();
        assertEquals(List.of("a.com", "b.com"), got);
    }

    @Test
    void validateRequiresRealmId() {
        Realm r = realm(null);
        assertThrows(RealmException.class, () -> r.origins().validate("", "https://x"));
    }

    /** Mutable clock so we can drive TTL-expiry tests deterministically. */
    private static final class MutableClock extends Clock {
        private Instant now;
        MutableClock(Instant start) { this.now = start; }
        void advance(java.time.Duration d) { now = now.plus(d); }
        @Override public java.time.ZoneId getZone() { return ZoneOffset.UTC; }
        @Override public Clock withZone(java.time.ZoneId zone) { return this; }
        @Override public Instant instant() { return now; }
        @Override public long millis() { return now.toEpochMilli(); }
    }
}

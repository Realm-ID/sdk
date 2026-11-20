package dev.realmid.sdk.info;

import dev.realmid.sdk.FakeServer;
import dev.realmid.sdk.http.HttpTransport;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.net.http.HttpClient;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;

class RealmInfoClientTest {
    private static final String REALM_ID = "01HREALM";

    private FakeServer fs;

    @BeforeEach
    void setUp() throws IOException { fs = new FakeServer(); }

    @AfterEach
    void tearDown() { fs.close(); }

    private static final class MutableClock extends Clock {
        volatile Instant now = Instant.parse("2026-11-19T00:00:00Z");
        @Override public java.time.ZoneId getZone() { return ZoneOffset.UTC; }
        @Override public Clock withZone(java.time.ZoneId z) { return this; }
        @Override public Instant instant() { return now; }
    }

    private RealmInfoClient realm(Clock clock) {
        HttpTransport http = new HttpTransport(fs.baseUrl,
                HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1).build(), FakeServer.M, null, null);
        return new RealmInfoClient(http, REALM_ID, true, clock);
    }

    private static Map<String, Object> row(Object audience, boolean withAudience) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", REALM_ID);
        if (withAudience) m.put("audience", audience);
        m.put("domain", "acme.test");
        return m;
    }

    @Test
    void failedDiscoveryIsNotCachedAndRetriesOncePerWindow() {
        AtomicInteger calls = new AtomicInteger();
        fs.on("GET /platforms/mine", (ex, body) -> {
            if (calls.incrementAndGet() <= 2) return FakeServer.Reply.json(500, Map.of("error", "down"));
            return FakeServer.Reply.json(200, Map.of("items", List.of(row("realmid:abc", true))));
        });
        MutableClock clock = new MutableClock();
        RealmInfoClient r = realm(clock);
        assertEquals("", r.info().audience());
        clock.now = clock.now.plus(Duration.ofSeconds(10));
        assertEquals("", r.info().audience());
        assertEquals(1, calls.get(), "inside the window no second attempt");
        clock.now = clock.now.plus(Duration.ofSeconds(21));
        assertEquals("", r.info().audience());
        assertEquals(2, calls.get());
        clock.now = clock.now.plus(Duration.ofSeconds(31));
        assertEquals("realmid:abc", r.info().audience());
        clock.now = clock.now.plus(Duration.ofHours(1));
        r.info();
        assertEquals(3, calls.get(), "a success stays cached");
    }

    @Test
    void rowWithoutAudienceIsAFailedDiscoveryNeverTheDomain() {
        for (Map<String, Object> row : List.of(row(null, false), row(null, true), row("", true))) {
            AtomicInteger calls = new AtomicInteger();
            fs.on("GET /platforms/mine", (ex, body) -> {
                calls.incrementAndGet();
                return FakeServer.Reply.json(200, Map.of("items", List.of(row)));
            });
            MutableClock clock = new MutableClock();
            RealmInfoClient r = realm(clock);
            assertEquals("", r.info().audience());
            clock.now = clock.now.plus(Duration.ofSeconds(31));
            assertEquals("", r.info().audience());
            assertEquals(2, calls.get(), "not cached: retried after the window");
        }
    }
}

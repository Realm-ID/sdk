package dev.realmid.sdk.http;

import dev.realmid.sdk.FakeServer;
import dev.realmid.sdk.Realm;
import dev.realmid.sdk.RealmException;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.net.http.HttpClient;
import java.time.Duration;
import java.time.ZoneOffset;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.util.Map;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** SPEC §3: {@code RealmException.getRetryAfter()} carries the server's Retry-After on any non-2xx. */
class RetryAfterTest {
    private FakeServer fs;
    private Realm realm;

    @BeforeEach
    void setUp() throws IOException {
        fs = new FakeServer();
        fs.on("POST /auth/login", (ex, body) -> FakeServer.Reply.json(200,
                Map.of("access_token", "pt", "refresh_token", "rt", "expires_in", 300,
                        "subject_type", "platform")));
        realm = Realm.builder().sessionStore(new dev.realmid.sdk.session.MemorySessionStore())
                .realmId("01HREALM")
                .apiKey("rk")
                .baseUrl(fs.baseUrl)
                .audience("acme.test")
                .httpClient(HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1).build())
                .build();
    }

    @AfterEach
    void tearDown() { fs.close(); }

    private RealmException failWith(int status, String retryAfter) {
        fs.on("GET /platforms/01HREALM/roles", (ex, b) -> {
            if (retryAfter != null) ex.getResponseHeaders().add("Retry-After", retryAfter);
            return FakeServer.Reply.json(status, Map.of("error", "slow down", "code", "phone_otp_rate_limited"));
        });
        return assertThrows(RealmException.class, () -> realm.roles().list());
    }

    @Test
    void deltaSecondsOn429() {
        RealmException e = failWith(429, "120");
        assertEquals(429, e.getHttpStatus());
        assertEquals(Optional.of(Duration.ofSeconds(120)), e.getRetryAfter());
    }

    @Test
    void presentOn503Too() {
        assertEquals(Optional.of(Duration.ofSeconds(7)), failWith(503, "7").getRetryAfter());
    }

    @Test
    void absentGarbageNonPositiveAreEmpty() {
        assertEquals(Optional.empty(), failWith(429, null).getRetryAfter());
        assertEquals(Optional.empty(), failWith(429, "soon").getRetryAfter());
        assertEquals(Optional.empty(), failWith(429, "-5").getRetryAfter());
        assertEquals(Optional.empty(), failWith(429, "0").getRetryAfter());
    }

    @Test
    void httpDateIsTheWaitFromNowAndPastIsEmpty() {
        String future = DateTimeFormatter.RFC_1123_DATE_TIME.format(ZonedDateTime.now(ZoneOffset.UTC).plusSeconds(90));
        Duration d = failWith(429, future).getRetryAfter().orElseThrow();
        assertTrue(d.getSeconds() >= 80 && d.getSeconds() <= 91, "got " + d);
        assertEquals(Optional.empty(), failWith(429, "Mon, 02 Jan 2006 15:04:05 GMT").getRetryAfter());
    }
}

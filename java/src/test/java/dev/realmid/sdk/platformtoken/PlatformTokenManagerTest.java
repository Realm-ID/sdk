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
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;

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
        return new PlatformTokenManager(CredentialSources.staticApiKey("rk_live_secret"), fs.baseUrl,
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
    void remintOnExpiryUsesLogin() {
        // ADR-089: a credential-bootstrapped session has no refresh token, so a
        // stale access token is replaced by re-presenting the credential, not by
        // /auth/token. The login reply deliberately carries NO refresh_token —
        // the shape a v0.68.0 issuer actually returns.
        AtomicInteger logins = new AtomicInteger();
        AtomicInteger refreshes = new AtomicInteger();
        fs.on("POST /auth/login", (ex, body) -> {
            int n = logins.incrementAndGet();
            return FakeServer.Reply.json(200, Map.of(
                    "access_token", "pt-login-" + n,
                    "expires_in", 60, "subject_type", "platform"));
        });
        fs.on("POST /auth/token", (ex, body) -> {
            refreshes.incrementAndGet();
            return FakeServer.Reply.json(200, Map.of(
                    "access_token", "pt-refresh", "expires_in", 60, "subject_type", "platform"));
        });
        long[] nowMs = { Instant.parse("2024-01-01T00:00:00Z").toEpochMilli() };
        var ptm = manager(mutableClock(nowMs));
        String first = ptm.getToken();
        // Advance past skew so the cached access token is stale.
        nowMs[0] += 50_000;
        String second = ptm.getToken();
        assertEquals(2, logins.get(), "a stale token re-mints via /auth/login");
        assertEquals(0, refreshes.get(), "ADR-089: /auth/token must not be called");
        assertNotEquals(first, second);
        assertEquals("pt-login-1", first);
        assertEquals("pt-login-2", second);
    }

    @Test
    void invalidateRemintsFromCredential() {
        AtomicInteger logins = new AtomicInteger();
        fs.on("POST /auth/login", (ex, body) -> {
            int n = logins.incrementAndGet();
            return FakeServer.Reply.json(200, Map.of(
                    "access_token", "pt-login-" + n, "expires_in", 300, "subject_type", "platform"));
        });
        fs.on("POST /auth/token", (ex, body) -> {
            throw new AssertionError("ADR-089: /auth/token must not be called");
        });
        var ptm = manager(Clock.systemUTC());
        assertEquals("pt-login-1", ptm.getToken());
        ptm.invalidate();
        assertEquals("pt-login-2", ptm.getToken());
        assertEquals(2, logins.get());
    }

    @Test
    void ignoresAStrayRefreshTokenInTheLoginReply() {
        // Interop with a PRE-ADR-089 issuer, which still returns a refresh
        // token: the manager must ignore it rather than start using
        // /auth/token, which on a current issuer answers
        // 401 m2m_refresh_withdrawn.
        AtomicInteger logins = new AtomicInteger();
        fs.on("POST /auth/login", (ex, body) -> {
            int n = logins.incrementAndGet();
            return FakeServer.Reply.json(200, Map.of(
                    "access_token", "pt-login-" + n, "refresh_token", "rt-" + n,
                    "expires_in", 300, "subject_type", "platform"));
        });
        fs.on("POST /auth/token", (ex, body) -> FakeServer.Reply.json(401,
                Map.of("error", Map.of("code", "m2m_refresh_withdrawn", "message", "no refresh token"))));
        var ptm = manager(Clock.systemUTC());
        ptm.getToken();
        ptm.invalidate();
        String tok = ptm.getToken();
        assertEquals(2, logins.get(), "the stray refresh token must not be used");
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

    @Test
    void tokenExchangeCredentialPostsSubjectToken() {
        fs.on("POST /auth/login", (ex, body) -> FakeServer.Reply.json(200, Map.of(
                "access_token", "pt-fed", "refresh_token", "rt-fed",
                "expires_in", 300, "subject_type", "platform")));
        CredentialSource cred = () -> Credential.ofWorkloadToken("workload.jwt.tok");
        var ptm = new PlatformTokenManager(cred, fs.baseUrl, HttpClient.newHttpClient(),
                new ObjectMapper(), null, Clock.systemUTC(), Duration.ofSeconds(30));

        assertEquals("pt-fed", ptm.getToken());
        Map<String, Object> body = fs.last().bodyAsMap();
        assertEquals("urn:ietf:params:oauth:grant-type:token-exchange", body.get("grant_type"));
        assertEquals("workload.jwt.tok", body.get("subject_token"));
        assertEquals("urn:ietf:params:oauth:token-type:jwt", body.get("subject_token_type"));
        assertNull(body.get("api_key"));
    }

    // ---- ADR-041 client-side realm pin (SPEC §4.0) ----
    //
    // Go (go/platform_token.go checkIssuer) and TS
    // (ts/src/platform-token-manager.ts checkIssuer) decode the freshly minted
    // platform access token and refuse it when its `iss` does not reference the
    // configured realm. Java carried only ErrorCode.REALM_MISMATCH, so the
    // confused-deputy case — SDK constructed for realm A, credential belonging
    // to realm B — surfaced as a cryptic 4xx on some later management call, or
    // not at all.

    private static final String REALM_A = "01HREALMA";
    private static final String REALM_B = "01HREALMB";

    private PlatformTokenManager managerFor(String realmId) {
        return new PlatformTokenManager(CredentialSources.staticApiKey("rk_live_secret"), fs.baseUrl,
                HttpClient.newHttpClient(), new ObjectMapper(), null,
                Clock.systemUTC(), Duration.ofSeconds(30), realmId);
    }

    /** An unsigned-but-well-formed JWT carrying just `iss`. The pin decodes the
     *  payload without verifying the signature — it just received the token
     *  from RI over TLS; signature checking stays the Verifier's job. */
    private static String jwtWithIssuer(String iss) {
        try {
            String hdr = b64(FakeServer.M.writeValueAsBytes(Map.of("alg", "RS256", "typ", "JWT")));
            Map<String, Object> claims = new LinkedHashMap<>();
            claims.put("iss", iss);
            claims.put("sub", "bot-user");
            String pl = b64(FakeServer.M.writeValueAsBytes(claims));
            return hdr + "." + pl + "." + b64("sig-not-checked-here".getBytes());
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    private static String b64(byte[] b) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(b);
    }

    private void serveLoginWithIssuer(String iss, AtomicInteger logins) {
        fs.on("POST /auth/login", (ex, body) -> {
            logins.incrementAndGet();
            return FakeServer.Reply.json(200, Map.of(
                    "access_token", jwtWithIssuer(iss),
                    "expires_in", 300, "subject_type", "platform"));
        });
    }

    @Test
    void realmPinRefusesATokenMintedForAnotherRealm() {
        AtomicInteger logins = new AtomicInteger();
        serveLoginWithIssuer("https://auth.realmid.dev/" + REALM_B, logins);
        var ptm = managerFor(REALM_A);

        RealmException ex = assertThrows(RealmException.class, ptm::getToken);
        assertEquals(ErrorCode.REALM_MISMATCH, ex.getCode());
        assertEquals(1, logins.get());
        // The refused token must not be cached: a second call re-mints and
        // refuses again rather than handing out the foreign-realm token.
        assertThrows(RealmException.class, ptm::getToken);
        assertEquals(2, logins.get());
    }

    @Test
    void realmPinAcceptsATokenMintedForTheConfiguredRealm() {
        // POSITIVE CONTROL. Without it, a pin that refused every token — or one
        // whose suffix comparison is inverted — would satisfy the test above.
        AtomicInteger logins = new AtomicInteger();
        String iss = "https://auth.realmid.dev/" + REALM_A;
        serveLoginWithIssuer(iss, logins);
        var ptm = managerFor(REALM_A);

        String tok = assertDoesNotThrow(ptm::getToken);
        assertEquals(jwtWithIssuer(iss), tok);
        assertEquals(1, logins.get());
    }

    @Test
    void realmPinIgnoresATokenItCannotDecode() {
        // Parity with Go (peekJWTIssuer error → return nil) and TS (peek returns
        // "" → skip): an opaque or malformed access token is NOT a realm
        // mismatch. The pin is a confused-deputy check, not a token validator —
        // a token whose provenance it cannot read is left to the Verifier.
        AtomicInteger logins = new AtomicInteger();
        fs.on("POST /auth/login", (ex, body) -> {
            logins.incrementAndGet();
            return FakeServer.Reply.json(200, Map.of(
                    "access_token", "pt-opaque", "expires_in", 300, "subject_type", "platform"));
        });
        var ptm = managerFor(REALM_A);
        assertEquals("pt-opaque", assertDoesNotThrow(ptm::getToken));
    }

    @Test
    void realmPinIsSkippedWhenNoRealmIdIsConfigured() {
        // The 7-arg constructor predates the pin and carries no realm to pin
        // against; it must keep working rather than start refusing. Mirrors
        // TS's `if (!this.opts.realmId) return`.
        AtomicInteger logins = new AtomicInteger();
        serveLoginWithIssuer("https://auth.realmid.dev/" + REALM_B, logins);
        var ptm = manager(Clock.systemUTC());
        assertDoesNotThrow(ptm::getToken);
    }
}

package dev.realmid.sdk.platformtoken;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.realmid.sdk.FakeServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.net.http.HttpClient;
import java.time.Clock;
import java.time.Duration;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;

/** SPEC §4.0.1: {@code platform_id} on the token-exchange grant. */
class PlatformIdTest {
    private static final String REALM = "11111111-2222-3333-4444-555555555555";
    private FakeServer fs;

    @BeforeEach void setUp() throws IOException {
        fs = new FakeServer();
        fs.on("POST /auth/token", (ex, body) -> FakeServer.Reply.json(200, Map.of(
                "access_token", "pt", "expires_in", 300, "subject_type", "platform")));
    }

    @AfterEach void tearDown() { fs.close(); }

    private Map<String, Object> exchange(CredentialSource cred) {
        var ptm = new PlatformTokenManager(cred, fs.baseUrl, HttpClient.newHttpClient(),
                new ObjectMapper(), null, Clock.systemUTC(), Duration.ofSeconds(30), REALM);
        ptm.getToken();
        return fs.last().bodyAsMap();
    }

    @Test
    void tokenExchangeSendsTheHandleRealmAsPlatformId() {
        assertEquals(REALM, exchange(() -> Credential.ofWorkloadToken("wl.jwt")).get("platform_id"));
    }

    @Test
    void credentialPlatformIdWinsOverTheHandleRealm() {
        assertEquals("plat-override",
                exchange(() -> Credential.ofWorkloadToken("wl.jwt", "plat-override")).get("platform_id"));
    }

    @Test
    void tokenExchangeOmitsPlatformIdWhenNoneIsNamed() {
        var ptm = new PlatformTokenManager(() -> Credential.ofWorkloadToken("wl.jwt"), fs.baseUrl,
                HttpClient.newHttpClient(), new ObjectMapper(), null, Clock.systemUTC(), Duration.ofSeconds(30), "");
        ptm.getToken();
        assertFalse(fs.last().bodyAsMap().containsKey("platform_id"));
    }

    @Test
    void platformApiKeyGrantNeverSendsPlatformId() {
        assertFalse(exchange(CredentialSources.staticApiKey("rk_live_x")).containsKey("platform_id"));
    }
}

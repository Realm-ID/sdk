package dev.realmid.sdk.integration;

import dev.realmid.sdk.Realm;
import dev.realmid.sdk.split.IntegrationHandlerOptions;
import dev.realmid.sdk.split.IntegrationTokenHandler;
import dev.realmid.sdk.split.IntegrationTokenHandler.Response;
import dev.realmid.sdk.split.SplitKit.Issuer;
import dev.realmid.sdk.split.SplitKit.Key;
import dev.realmid.sdk.split.SplitKit.MemShares;
import dev.realmid.sdk.split.SplitKit.Seen;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static dev.realmid.sdk.split.SplitKit.*;
import static org.junit.jupiter.api.Assertions.*;

/** SPEC14_8_integration (R47, R50, R67.2); the inbound {"pass": ...} body is [inferred] (mirrors go). */
class IntegrationTokenHandlerTest {

    private static Response post(IntegrationTokenHandler h, String pass) {
        return h.handle("POST", "198.51.100.7:4000", "{\"pass\":\"" + pass + "\"}");
    }

    private static Seen passMint(Issuer f) {
        Seen mint = null;
        for (Seen r : f.reqs("/auth/token")) if ("integration_installation".equals(r.body().get("grant_type"))) mint = r;
        return mint;
    }

    @Test
    void forwardsPassInXUserTokenWithTargetPlatformToken() throws Exception {
        try (Issuer f = new Issuer()) {
            f.on("/auth/token", r -> json(200, Map.of("access_token", "TARGET-AT", "expires_in", 600, "tenant_id", "t1", "role", "member")));
            Response rec = post(new IntegrationTokenHandler(f.realm(null), new IntegrationHandlerOptions(0)), "ip_abc");
            Seen mint = passMint(f);
            assertNotNull(mint, "no integration_installation mint reached /auth/token; handler answered " + rec);
            assertEquals("Bearer ptok", mint.auth());
            assertEquals("ip_abc", mint.userToken(), "pass must ride in X-User-Token");
            for (Object v : mint.body().values()) {
                assertFalse(v instanceof String s && s.contains("ip_abc"), "pass leaked into the body (R67.2: header only)");
            }
            assertTrue(f.reqs("/auth/token/partial").isEmpty(), "full target hit /auth/token/partial");
        }
    }

    @Test
    void fullTargetRelaysIssuerAnswerVerbatim() throws Exception {
        try (Issuer f = new Issuer()) {
            f.on("/auth/token", r -> err(401, "install_pass_invalid", "spent"));
            Response rec = post(new IntegrationTokenHandler(f.realm(null), new IntegrationHandlerOptions(0)), "ip_spent");
            assertEquals(401, rec.status(), "relay status: " + rec);
            assertTrue(rec.body().contains("install_pass_invalid"), "relay body: " + rec.body());
        }
    }

    @Test
    void splitTargetFinishesHalfSignedAnswer() throws Exception {
        Key k = newKey("split-1");
        try (Issuer f = new Issuer()) {
            f.on("/auth/token/partial", r -> json(200, k.partialAnswer(userClaims(f.issuer()), "")));
            Realm r = f.realm(b -> b.split(true).shareSource(new MemShares(k.bundle(REALM))));
            Response rec = post(new IntegrationTokenHandler(r, new IntegrationHandlerOptions(0)), "ip_abc");
            String at = (String) M.readValue(rec.body(), Map.class).get("access_token");
            assertTrue(at != null && !at.isEmpty(), "split target: " + rec);
            String[] parts = at.split("\\.");
            assertEquals(3, parts.length, "unfinished token: " + at);
            assertTrue(verifies(k.pub, (parts[0] + "." + parts[1]).getBytes(StandardCharsets.UTF_8), UB64.decode(parts[2])),
                    "handler returned an unverifiable token");
            List<Seen> pr = f.reqs("/auth/token/partial");
            assertEquals(1, pr.size());
            assertEquals("ip_abc", pr.get(0).userToken());
            assertEquals("Bearer ptok", pr.get(0).auth());
        }
    }

    @Test
    void rateLimitsBeforeCallingIssuer() throws Exception {
        try (Issuer f = new Issuer()) {
            f.on("/auth/token", r -> json(200, Map.of("access_token", "AT", "expires_in", 600)));
            IntegrationTokenHandler h = new IntegrationTokenHandler(f.realm(null), new IntegrationHandlerOptions(2));
            List<Integer> codes = new ArrayList<>();
            for (int i = 0; i < 4; i++) codes.add(post(h, "ip_a").status());
            assertEquals(List.of(200, 200, 429, 429), codes, "status sequence");
            int mints = 0;
            for (Seen r : f.reqs("/auth/token")) if ("integration_installation".equals(r.body().get("grant_type"))) mints++;
            assertEquals(2, mints, "issuer mints (limited requests must not reach it)");
        }
    }

    @Test
    void rejectsNonPostAndMissingPassWithoutCallingIssuer() throws Exception {
        try (Issuer f = new Issuer()) {
            IntegrationTokenHandler h = new IntegrationTokenHandler(f.realm(null), new IntegrationHandlerOptions(0));
            assertEquals(405, h.handle("GET", "198.51.100.7:4000", "").status(), "GET");
            assertEquals(400, h.handle("POST", "198.51.100.7:4000", "{}").status(), "missing pass");
            assertNull(passMint(f), "issuer called for a request with no pass");
        }
    }
}

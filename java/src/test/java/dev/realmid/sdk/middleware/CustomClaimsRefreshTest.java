package dev.realmid.sdk.middleware;

import dev.realmid.sdk.FakeServer;
import dev.realmid.sdk.Realm;
import dev.realmid.sdk.auth.CustomClaimsHandler;
import dev.realmid.sdk.auth.LoginRequest;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Audit e-01 (owner ruling 3, 2026-11-14): the refresh route never relays a
 * browser-sent {@code custom_claims}; custom claims come ONLY from the
 * server-side {@code customClaims(tenantId, userId)} handler.
 * Spec: sdk/SPEC.md SPEC10_1_4_no_client_claims, SPEC10_1_4a_fingerprint,
 * SPEC10_2_custom_claims (rules 1-6), SPEC4_2_claim_fold rule 1.
 */
class CustomClaimsRefreshTest {

    private static final String REALM_ID = "01HREALM";

    private FakeServer fs;
    private List<Map<String, Object>> mints;
    private AtomicInteger mintCount;

    @BeforeEach
    void setUp() throws IOException {
        fs = new FakeServer();
        mints = new ArrayList<>();
        mintCount = new AtomicInteger();
        fs.onJson("POST /auth/login", (body, rec) -> {
            if ("platform_api_key".equals(body.get("grant_type"))) {
                return FakeServer.Reply.json(200, Map.of("access_token", "pt-12345", "refresh_token", "rt",
                        "expires_in", 300, "subject_type", "platform"));
            }
            return FakeServer.Reply.json(200, Map.of("access_token", "at-login", "refresh_token", "rtok",
                    "user", Map.of("id", "u1"),
                    "tenants", List.of(Map.of("tenant_id", "t1", "role", "owner"))));
        });
        fs.onJson("POST /auth/token", (body, rec) -> {
            mintCount.incrementAndGet();
            mints.add(body);
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("access_token", jwtWithSub("u-refresh"));
            out.put("refresh_token", "rtok" + mintCount.get());
            out.put("expires_in", 900);
            out.put("subject_type", "user");
            out.put("tenant_id", "t1");
            out.put("role", "member");
            return FakeServer.Reply.json(200, out);
        });
    }

    @AfterEach
    void tearDown() { fs.close(); }

    private static String jwtWithSub(String sub) {
        Base64.Encoder e = Base64.getUrlEncoder().withoutPadding();
        String h = e.encodeToString("{\"alg\":\"RS256\",\"kid\":\"kid-1\"}".getBytes(StandardCharsets.UTF_8));
        String p = e.encodeToString(("{\"sub\":\"" + sub + "\",\"tenant_id\":\"t1\"}").getBytes(StandardCharsets.UTF_8));
        return h + "." + p + ".c2ln";
    }

    private Realm realmWith(CustomClaimsHandler h) {
        Realm.Builder b = Realm.builder().sessionStore(new dev.realmid.sdk.session.MemorySessionStore())
                .realmId(REALM_ID).apiKey("rk_live_test").baseUrl(fs.baseUrl).audience("acme.test");
        if (h != null) b = b.customClaims(h);
        return b.build();
    }

    private RealmFilterTest.FakeRes refresh(Realm realm, String body) throws Exception {
        RealmFilter f = realm.middleware().buildFilter();
        RealmFilterTest.FakeReq req = new RealmFilterTest.FakeReq("POST", "/token");
        req.headers.put("Cookie", List.of("realmid_refresh=rtok"));
        req.body = body.getBytes(StandardCharsets.UTF_8);
        RealmFilterTest.FakeRes res = new RealmFilterTest.FakeRes();
        f.doFilter(req, res, (rq, rs) -> { throw new AssertionError("chain must not run"); });
        return res;
    }

    private static String text(RealmFilterTest.FakeRes r) { return new String(r.out.toByteArray(), StandardCharsets.UTF_8); }

    private Map<String, Object> lastMint() { return mints.get(mints.size() - 1); }

    @Test
    void SPEC10_1_4_browserCustomClaimsIsRefusedWithoutCallingTheIssuer() throws Exception {
        Realm realm = realmWith(null);
        for (String key : new String[]{"custom_claims", "customClaims"}) {
            for (String val : new String[]{"{\"outlet_ids\":[\"o1\"]}", "null", "{}", "\"x\"", "5"}) {
                RealmFilterTest.FakeRes res = refresh(realm, "{\"tenant_id\":\"t1\",\"" + key + "\":" + val + "}");
                assertEquals(400, res.status, key + "=" + val);
                assertTrue(text(res).contains("\"custom_claims_not_accepted\""), text(res));
            }
        }
        assertEquals(0, mintCount.get(), "the issuer must not be called, the refresh token must not be consumed");
    }

    @Test
    void SPEC10_2_handlerOutputIsTheOnlySourceAndGetsTenantAndSubject() throws Exception {
        List<String> args = new ArrayList<>();
        Realm realm = realmWith((tenantId, userId) -> {
            args.add(tenantId + "/" + userId);
            return Map.of("outlet_ids", List.of("o1"));
        });

        RealmFilterTest.FakeRes res = refresh(realm, "{\"tenant_id\":\"t1\"}");

        assertEquals(200, res.status);
        assertEquals(List.of("t1/u-refresh"), args);
        assertEquals(Map.of("outlet_ids", List.of("o1")), lastMint().get("custom_claims"));
    }

    @Test
    void SPEC10_2_noHandlerMintsNoCustomClaims() throws Exception {
        RealmFilterTest.FakeRes res = refresh(realmWith(null), "{\"tenant_id\":\"t1\"}");
        assertEquals(200, res.status);
        assertEquals(1, mintCount.get());
        assertFalse(lastMint().containsKey("custom_claims"));
    }

    @Test
    void SPEC10_2_emptyHandlerOutputMintsNoCustomClaimsAndNoRemint() throws Exception {
        RealmFilterTest.FakeRes res = refresh(realmWith((t, u) -> Map.of()), "{\"tenant_id\":\"t1\"}");
        assertEquals(200, res.status);
        assertEquals(1, mintCount.get());
        assertFalse(lastMint().containsKey("custom_claims"));
    }

    @Test
    void SPEC10_2_handlerErrorRetriesThreeTimesThenRefusesTheMint() throws Exception {
        AtomicInteger calls = new AtomicInteger();
        Realm realm = realmWith((t, u) -> { calls.incrementAndGet(); throw new IllegalStateException("db down"); });
        RealmFilterTest.FakeRes res = refresh(realm, "{\"tenant_id\":\"t1\"}");
        assertEquals(503, res.status);
        assertEquals(3, calls.get());
        assertEquals(1, mintCount.get(), "only the identity mint; no claim-less re-mint");
    }

    @Test
    void SPEC4_2_claimFold_handlerOutputWithBadKeyRefusesTheMintNamingTheKey() throws Exception {
        for (String bad : new String[]{"Sub", "ACR", "région"}) {
            mints.clear();
            Realm realm = realmWith((t, u) -> Map.of(bad, "x"));
            RealmFilterTest.FakeRes res = refresh(realm, "{\"tenant_id\":\"t1\"}");
            assertEquals(503, res.status, bad);
            assertTrue(text(res).contains(bad), text(res));
            assertEquals(1, mints.size(), "no re-mint carrying the bad key: " + bad);
        }
    }

    /** SPEC10_2: the handler runs on EVERY SDK-run mint, so the login lane too. */
    @Test
    void SPEC10_2_loginMintCarriesHandlerClaims() {
        Realm realm = realmWith((t, u) -> Map.of("outlet_ids", List.of(t + "/" + u)));
        realm.auth().login(LoginRequest.of("firebase", "pt"));
        assertEquals(1, mints.size());
        assertEquals(Map.of("outlet_ids", List.of("t1/u1")), lastMint().get("custom_claims"));
    }
}

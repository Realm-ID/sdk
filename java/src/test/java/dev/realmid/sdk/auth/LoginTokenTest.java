package dev.realmid.sdk.auth;

import dev.realmid.sdk.Realm;
import dev.realmid.sdk.RealmException;
import dev.realmid.sdk.split.SplitKit.Issuer;
import dev.realmid.sdk.split.SplitKit.Seen;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static dev.realmid.sdk.split.SplitKit.json;
import static org.junit.jupiter.api.Assertions.*;

/**
 * SPEC14_1_login_token (R44, R62, R71): login authenticates; /auth/token mints. The fake login answers WITH a
 * stray access_token to prove the SDK never reads it (mirrors go login_token_test.go).
 */
class LoginTokenTest {

    private static Issuer loginFake(List<Object> tenants) throws Exception {
        Issuer f = new Issuer();
        f.on("/auth/login", r -> json(200, Map.of("access_token", "LEAKED-FROM-LOGIN", "refresh_token", "rt1",
                "expires_in", 900, "user", Map.of("id", "u1"), "tenants", tenants)));
        f.on("/auth/token", r -> json(200, Map.of("access_token", "MINTED-AT", "refresh_token", "rt2",
                "expires_in", 600, "tenant_id", "t1", "role", "member")));
        return f;
    }

    @Test
    void singleTenantMintsAtAuthTokenAndIgnoresLoginAccessToken() throws Exception {
        try (Issuer f = loginFake(List.of(Map.of("tenant_id", "t1", "role", "member")))) {
            Session s = f.realm(null).auth().login(LoginRequest.of("google", "pt"));
            assertEquals("MINTED-AT", s.accessToken(), "want the /auth/token mint, never login's access_token");
            List<Seen> mints = f.userMints();
            assertEquals(1, mints.size(), "user mints at /auth/token (auto-mint on exactly one tenant, R44)");
            assertEquals("rt1", mints.get(0).body().get("refresh_token"));
            assertEquals("t1", mints.get(0).body().get("tenant_id"));
            assertEquals("Bearer ptok", mints.get(0).auth());
        }
    }

    @Test
    void multiTenantDoesNotMintAndDropsLoginAccessToken() throws Exception {
        try (Issuer f = loginFake(List.of(Map.of("tenant_id", "t1"), Map.of("tenant_id", "t2")))) {
            Realm r = f.realm(null);
            Session s = r.auth().login(LoginRequest.of("google", "pt"));
            assertTrue(s.accessToken() == null || s.accessToken().isEmpty(),
                    "AccessToken = " + s.accessToken() + " before tenant choice; the SDK must never surface login's access_token");
            assertTrue(s.needsTenantChoice(), "needsTenantChoice = false");
            Session done = r.auth().completeLogin(s, "t2", null);
            assertEquals("MINTED-AT", done.accessToken(), "after choice want the mint");
        }
    }

    @Test
    void mfaVerifyExchangesAtAuthTokenToo() throws Exception {
        try (Issuer f = loginFake(List.of())) {
            f.on("/auth/mfa/verify", r -> json(200, Map.of("access_token", "LEAKED-FROM-VERIFY", "refresh_token", "rt1",
                    "expires_in", 900, "tenants", List.of(Map.of("tenant_id", "t1", "role", "member")))));
            Session s = f.realm(null).auth().mfaVerify(MFAVerifyRequest.of("ct", "123456"));
            assertEquals("MINTED-AT", s.accessToken(), "MFA verify must exchange at /auth/token (R51)");
        }
    }

    @Test
    void platformMintOnAuthTokenOnlyNoLoginFallback() throws Exception {
        try (Issuer f = new Issuer()) {
            f.on("/tenants/t1", r -> json(200, Map.of("id", "t1")));
            f.realm(null).tenants().get("t1");
            assertEquals(0, f.reqs("/auth/login").size(), "platform_api_key was sent to /auth/login");
            List<Seen> pm = f.reqs("/auth/token");
            assertEquals(1, pm.size(), "platform mint at /auth/token: " + pm);
            assertEquals("platform_api_key", pm.get(0).body().get("grant_type"));
            assertEquals("rk", pm.get(0).body().get("api_key"));
        }
    }

    @Test
    void noFallbackToLoginWhenTokenEndpointFails() throws Exception {
        try (Issuer f = new Issuer()) {
            f.oldIssuer = true;
            assertThrows(RealmException.class, () -> f.realm(null).tenants().get("t1"),
                    "expected an error from an issuer without /auth/token platform mint");
            assertEquals(0, f.reqs("/auth/login").size(), "fell back to /auth/login; R71 forbids any fallback");
        }
    }
}

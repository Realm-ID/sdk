package dev.realmid.sdk.auth;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.realmid.sdk.ErrorCode;
import dev.realmid.sdk.FakeServer;
import dev.realmid.sdk.Realm;
import dev.realmid.sdk.RealmException;
import dev.realmid.sdk.idp.IdentityProvidersResponse;
import dev.realmid.sdk.me.MeAuth;
import dev.realmid.sdk.me.PasswordSet;
import dev.realmid.sdk.me.SetPasswordRequest;
import dev.realmid.sdk.session.MemorySessionStore;
import dev.realmid.sdk.tenants.PasswordResetSent;
import dev.realmid.sdk.tenants.SetCredentialsRequest;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** ADR-111 / SPEC 4.1.8, 4.10, 6.3 (java 0.51.0; mirrors go password_reset_test.go). */
class PasswordResetTest {
    private FakeServer fs;
    private Realm realm;
    // Fails the password grant only: the platform-token exchange shares POST /auth/login.
    private volatile FakeServer.Reply passwordGrantFailure;

    @BeforeEach
    void setUp() throws IOException {
        fs = new FakeServer();
        fs.on("POST /auth/login", (ex, b) -> {
            if (passwordGrantFailure != null && new String(b).contains("\"password\"")) return passwordGrantFailure;
            return FakeServer.Reply.json(200, Map.of(
                    "access_token", "a", "refresh_token", "r", "expires_in", 300, "user", Map.of("id", "u")));
        });
        realm = Realm.builder().sessionStore(new MemorySessionStore()).realmId("01HREALM").apiKey("rk")
                .baseUrl(fs.baseUrl).audience("acme.test").build();
    }

    @AfterEach
    void tearDown() { fs.close(); }

    private static String err(String code) {
        return "{\"error\":{\"code\":\"" + code + "\",\"message\":\"m\"}}";
    }

    @Test
    void passwordLogin_newPasswordOnWireOnlyWhenSet() {
        realm.auth().passwordLogin(PasswordLoginRequest.of("a@b.c", "old").withNewPassword("brand-new-pass-1"));
        Map<String, Object> got = fs.last().bodyAsMap();
        assertEquals("brand-new-pass-1", got.get("new_password"));
        assertEquals("old", got.get("presented"));
        realm.auth().passwordLogin(PasswordLoginRequest.of("a@b.c", "old"));
        assertFalse(fs.last().bodyAsMap().containsKey("new_password"), fs.last().bodyAsMap().toString());
        realm.auth().passwordLogin(PasswordLoginRequest.of("a@b.c", "old").withNewPassword(""));
        assertFalse(fs.last().bodyAsMap().containsKey("new_password"), "empty is omitted");
    }

    @Test
    void passwordLoginRequest_toStringNeverCarriesASecret() {
        String s = PasswordLoginRequest.of("a@b.c", "oldsecret").withNewPassword("newsecret").toString();
        assertFalse(s.contains("oldsecret") || s.contains("newsecret"), s);
    }

    @Test
    void inspectPasswordReset() {
        fs.on("POST /auth/password/reset/inspect", (ex, b) -> {
            assertNull(ex.getRequestURI().getRawQuery(), "token must not be in the query");
            return FakeServer.Reply.json(200, Map.of("data", Map.of("expires_at", "2026-10-09T12:30:00Z")));
        });
        PasswordResetInspection out = realm.auth().inspectPasswordReset("tok43");
        assertEquals(Map.of("token", "tok43"), fs.last().bodyAsMap());
        assertTrue(fs.last().header("authorization").startsWith("Bearer "));
        assertEquals(Instant.parse("2026-10-09T12:30:00Z"), out.expiresAt());
    }

    @Test
    void consumePasswordReset_body() {
        fs.on("POST /auth/password/reset", (ex, b) -> FakeServer.Reply.json(200,
                Map.of("data", Map.of("status", "password_set"))));
        PasswordResetConsumed out = realm.auth().consumePasswordReset("tok43", "a-long-new-password");
        assertEquals("tok43", fs.last().bodyAsMap().get("token"));
        assertEquals("a-long-new-password", fs.last().bodyAsMap().get("new_password"));
        assertEquals(List.of(), out.revokedSids());
    }

    @Test
    void consumePasswordReset_errorsAreTypedAndNotRetried() {
        Object[][] cases = {
                {400, ErrorCode.RESET_TOKEN_INVALID}, {410, ErrorCode.RESET_TOKEN_EXPIRED},
                {410, ErrorCode.RESET_TOKEN_USED}, {410, ErrorCode.RESET_TOKEN_SUPERSEDED}};
        for (Object[] c : cases) {
            AtomicInteger calls = new AtomicInteger();
            ErrorCode code = (ErrorCode) c[1];
            fs.on("POST /auth/password/reset", (ex, b) -> {
                calls.incrementAndGet();
                return FakeServer.Reply.json(((Integer) c[0]), FakeServer.M.createObjectNode()
                        .set("error", FakeServer.M.createObjectNode().put("code", code.wire()).put("message", "m")));
            });
            RealmException e = assertThrows(RealmException.class,
                    () -> realm.auth().consumePasswordReset("t", "pw-long-enough-12"));
            assertEquals(code, e.getCode());
            assertEquals(1, calls.get(), code.wire());
            assertFalse(String.valueOf(e.getMessage()).contains("pw-long-enough-12"));
        }
    }

    @Test
    void sendPasswordReset() {
        fs.on("POST /tenants/t1/users/u1/password-reset", (ex, b) -> FakeServer.Reply.json(202, Map.of("data",
                Map.of("status", "sent", "to", "a***@example.com", "expires_at", "2026-10-09T12:30:00Z"))));
        PasswordResetSent out = realm.tenants().users().sendPasswordReset("t1", "u1");
        assertEquals("POST", fs.last().method);
        assertEquals(0, fs.last().body.length);
        assertEquals("sent", out.status());
        assertEquals("a***@example.com", out.to());
        assertEquals(Instant.parse("2026-10-09T12:30:00Z"), out.expiresAt());
    }

    @Test
    void sendPasswordReset_typedErrors() {
        assertTyped(409, ErrorCode.NO_VERIFIED_EMAIL, "POST /tenants/t1/users/u1/password-reset",
                () -> realm.tenants().users().sendPasswordReset("t1", "u1"));
        assertTyped(429, ErrorCode.RESET_THROTTLED, "POST /tenants/t1/users/u1/password-reset",
                () -> realm.tenants().users().sendPasswordReset("t1", "u1"));
    }

    @Test
    void setCredentials() {
        fs.on("PUT /tenants/t1/users/u1/credentials", (ex, b) -> FakeServer.Reply.empty(204));
        realm.tenants().users().setCredentials("t1", "u1", SetCredentialsRequest.username("bob"));
        assertEquals("PUT", fs.last().method);
        assertEquals(Map.of("username", "bob"), fs.last().bodyAsMap());
        realm.tenants().users().setCredentials("t1", "u1", SetCredentialsRequest.password("temp-pass-12345"));
        assertEquals(Map.of("password", "temp-pass-12345"), fs.last().bodyAsMap());
    }

    @Test
    void setCredentials_typedErrors() {
        for (ErrorCode code : List.of(ErrorCode.RESET_LINK_REQUIRED, ErrorCode.VERIFIED_EMAIL_REQUIRED)) {
            assertTyped(409, code, "PUT /tenants/t1/users/u1/credentials",
                    () -> realm.tenants().users().setCredentials("t1", "u1", SetCredentialsRequest.password("x")));
        }
    }

    @Test
    void passwordLogin_changeCodesTyped() {
        for (ErrorCode code : List.of(ErrorCode.PASSWORD_UNCHANGED, ErrorCode.PASSWORD_CHANGE_NOT_REQUIRED)) {
            assertTyped(400, code, "POST /auth/login", () -> realm.auth().passwordLogin(
                    PasswordLoginRequest.of("i", "p").withNewPassword("n")));
        }
    }

    @Test
    void passwordMustChange_staysOnServerCode() {
        // SPEC 3.1: deliberately NOT registered; arrives as forbidden + details.server_code.
        passwordGrantFailure = FakeServer.Reply.json(403, Map.of("error",
                Map.of("code", "password_must_change", "message", "m")));
        RealmException e = assertThrows(RealmException.class,
                () -> realm.auth().passwordLogin(PasswordLoginRequest.of("i", "p")));
        assertEquals(ErrorCode.FORBIDDEN, e.getCode());
        assertEquals("password_must_change", e.getDetails().get("server_code"));
    }

    @Test
    void me_setPasswordRequestShapePerLane() {
        fs.on("PUT /me/password", (ex, b) -> FakeServer.Reply.json(200,
                Map.of("data", Map.of("status", "updated", "revoked_sids", List.of()))));
        PasswordSet out = realm.me().setPassword(
                SetPasswordRequest.change("old-old-old-1", "new-new-new-12"), MeAuth.bearer("ub"));
        assertEquals("updated", out.status());
        assertEquals("PUT", fs.last().method);
        assertEquals("Bearer ub", fs.last().header("authorization"));
        assertEquals(Map.of("current_password", "old-old-old-1", "new_password", "new-new-new-12"),
                fs.last().bodyAsMap());

        realm.me().setPassword(SetPasswordRequest.of("new-new-new-12"), MeAuth.onBehalfOf("ut"));
        assertEquals("ut", fs.last().header("X-User-Token"));
        assertEquals("Bearer a", fs.last().header("authorization")); // platform token stays the bearer
        assertEquals(Map.of("new_password", "new-new-new-12"), fs.last().bodyAsMap());
    }

    @Test
    void passwordPolicy_discoveryNullableNotFalse() throws Exception {
        ObjectMapper m = new ObjectMapper();
        IdentityProvidersResponse with = m.readValue("{\"providers\":[],\"credential_methods\":[\"password\"],"
                + "\"password_policy\":{\"require_verified_email\":false}}", IdentityProvidersResponse.class);
        assertNotNull(with.passwordPolicy());
        assertFalse(with.passwordPolicy().requireVerifiedEmail());
        IdentityProvidersResponse without = m.readValue("{\"providers\":[]}", IdentityProvidersResponse.class);
        assertNull(without.passwordPolicy(), "absent must be null, never false");
        assertFalse(m.writeValueAsString(without).contains("password_policy"), "nil policy re-serialised");
        assertTrue(m.writeValueAsString(with).contains("\"require_verified_email\":false"));
    }

    private void assertTyped(int status, ErrorCode code, String route, Runnable call) {
        FakeServer.Reply failure = new FakeServer.Reply(status, err(code.wire()).getBytes(), "application/json");
        if (route.equals("POST /auth/login")) passwordGrantFailure = failure; else fs.on(route, (ex, b) -> failure);
        RealmException e = assertThrows(RealmException.class, call::run, code.wire());
        assertEquals(code, e.getCode());
    }
}

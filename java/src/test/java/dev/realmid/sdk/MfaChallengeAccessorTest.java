package dev.realmid.sdk;

import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** SPEC 3.2: RealmException.getMfaChallenge() reads the step-up challenge a 412 carries. */
class MfaChallengeAccessorTest {

    @Test void readsTokenAndMethodsFromDetails() {
        RealmException e = new RealmException(ErrorCode.MFA_REGISTRATION_REQUIRED, "m", 412,
                Map.of("mfa_challenge_token", "enroll-tok-1", "methods", List.of("totp", 7, "otp")));
        var c = e.getMfaChallenge();
        assertEquals("enroll-tok-1", c.challengeToken());
        assertEquals(List.of("totp", "otp"), c.methods());
    }

    @Test void missingOrMistypedGivesEmptyNeverNull() {
        var none = new RealmException(ErrorCode.MFA_REQUIRED, "m", 412, null).getMfaChallenge();
        assertEquals("", none.challengeToken());
        assertTrue(none.methods().isEmpty());
        var bad = new RealmException(ErrorCode.MFA_REQUIRED, "m", 412,
                Map.of("mfa_challenge_token", 5, "methods", "totp")).getMfaChallenge();
        assertEquals("", bad.challengeToken());
        assertTrue(bad.methods().isEmpty());
    }

    @Test void mintMfaChallenge412CarriesTokenViaAccessor() throws Exception {
        try (FakeServer api = new FakeServer()) {
            api.on("POST /auth/login", (ex, body) -> FakeServer.Reply.json(200, Map.of(
                    "access_token", "pt", "refresh_token", "rt", "expires_in", 300, "subject_type", "platform")));
            api.on("POST /auth/mfa/challenge", (ex, body) -> FakeServer.Reply.json(412, Map.of("error", Map.of(
                    "code", "mfa_registration_required", "message", "mfa registration required",
                    "mfa_challenge_token", "enroll-tok-1", "tenant_id", "t1", "methods", List.of("totp")))));
            Realm realm = Realm.builder().sessionStore(new dev.realmid.sdk.session.MemorySessionStore())
                    .realmId("r").apiKey("rk").baseUrl(api.baseUrl).audience("aud").build();
            RealmException e = assertThrows(RealmException.class, () -> realm.auth().mintMfaChallenge("user-jwt"));
            assertEquals(ErrorCode.MFA_REGISTRATION_REQUIRED, e.getCode());
            assertEquals("enroll-tok-1", e.getMfaChallenge().challengeToken());
            assertEquals(List.of("totp"), e.getMfaChallenge().methods());
        }
    }
}

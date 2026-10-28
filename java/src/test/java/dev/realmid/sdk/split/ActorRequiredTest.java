package dev.realmid.sdk.split;

import dev.realmid.sdk.ActorRequiredException;
import dev.realmid.sdk.ErrorCode;
import dev.realmid.sdk.RealmException;
import dev.realmid.sdk.auth.RevokeAllSessionsRequest;
import dev.realmid.sdk.pagination.PageOpts;
import org.junit.jupiter.api.Test;

import static dev.realmid.sdk.split.SplitKit.*;
import static org.junit.jupiter.api.Assertions.*;

/**
 * R86 / SPEC14_10_actor: ONE typed error for the SDK's local refusal and the server's 403 actor_required.
 * Java: {@code ActorRequiredException extends RealmException} + {@code RealmException.isActorRequired(t)}.
 */
class ActorRequiredTest {

    private static void assertActorRequired(String what, Throwable t) {
        assertNotNull(t, what + ": want actor_required, got nothing");
        assertInstanceOf(ActorRequiredException.class, t, what + ": not the typed error; got " + t);
        assertTrue(RealmException.isActorRequired(t), what + ": isActorRequired = false; " + t);
        assertEquals(ErrorCode.ACTOR_REQUIRED, ((RealmException) t).getCode(), what + ": code");
        assertTrue(t.getMessage().contains("X-User-Token"), what + ": message lacks the X-User-Token hint: " + t.getMessage());
    }

    @Test
    void serverCodeDecodedToTypedError() throws Exception {
        try (Issuer f = new Issuer()) {
            f.on("/tenants/t1", r -> err(403, "actor_required", "needs an actor"));
            RealmException e = assertThrows(RealmException.class, () -> f.realm(null).tenants().get("t1"));
            assertActorRequired("server 403", e);
            assertEquals(403, e.getHttpStatus(), "HTTP status kept");
        }
    }

    @Test
    void localRefusalIsTheSameTypedErrorAndSendsNothing() throws Exception {
        try (Issuer f = new Issuer()) {
            f.on("/me/contacts", r -> json(200, java.util.Map.of("items", java.util.List.of())));
            f.on("/auth/sessions", r -> json(200, java.util.Map.of("items", java.util.List.of())));
            var realm = f.realm(null);
            // a bare platform call on an actor route (R61): no withUserToken, no MeAuth token
            Throwable t = assertThrows(Throwable.class, () -> realm.me().listContacts(null).page(PageOpts.empty()));
            assertActorRequired("local refusal (me)", t);
            assertEquals(0, f.reqs("/me/contacts").size(), "local refusal still sent a request to /me/contacts");
            // a user id without the user's token: today BAD_REQUEST, R86 makes it the typed error
            Throwable t2 = assertThrows(Throwable.class,
                    () -> realm.auth().revokeAllSessions(RevokeAllSessionsRequest.forUser("u1")));
            assertActorRequired("local refusal (revokeAllSessions, id without token)", t2);
            assertEquals(0, f.reqs("/auth/sessions").size(), "local refusal sent a request");
        }
    }

    @Test
    void predicateIsSafeAndSeesThroughWrapping() {
        assertFalse(RealmException.isActorRequired(null));
        assertFalse(RealmException.isActorRequired(new RuntimeException("x")));
        assertFalse(RealmException.isActorRequired(new RealmException(ErrorCode.BAD_REQUEST, "x")));
        ActorRequiredException typed = new ActorRequiredException(ActorRequiredException.HINT, 403, null);
        assertTrue(RealmException.isActorRequired(typed), "predicate false for the typed error itself");
        // seen through a wrapper (the Java analogue of Go's %w)
        assertTrue(RealmException.isActorRequired(new RuntimeException("job failed", typed)),
                "predicate false through cause wrapping");
        assertEquals("actor_required", ErrorCode.ACTOR_REQUIRED.wire());
    }
}

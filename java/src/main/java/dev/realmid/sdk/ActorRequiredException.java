package dev.realmid.sdk;

/**
 * R86: the ONE typed error for {@code 403 actor_required} and for the SDK's local refusal of a call that
 * needs an actor (SPEC §14.10). The response decoder builds it for the server's code and the escort-form
 * guards build it locally, before anything is sent. Test it with {@link RealmException#isActorRequired}.
 */
public final class ActorRequiredException extends RealmException {

    public static final String HINT =
            "This action needs a user or service account. Send its token in X-User-Token.";

    public ActorRequiredException(String message, int httpStatus, java.util.Map<String, Object> details) {
        super(ErrorCode.ACTOR_REQUIRED, message, httpStatus, details);
    }

    /** The SDK's own refusal: names the call, carries the hint, status 0 (nothing was sent). */
    public static ActorRequiredException local(String call) {
        return new ActorRequiredException(call + " needs an actor. " + HINT, 0, null);
    }

    /** Decoder entry: the hint first, then the issuer's own message when it adds something. */
    public static ActorRequiredException fromServer(String serverMessage, int httpStatus,
                                                    java.util.Map<String, Object> details) {
        String m = serverMessage == null || serverMessage.isEmpty() ? HINT
                : serverMessage.contains("X-User-Token") ? serverMessage : HINT + " (" + serverMessage + ")";
        return new ActorRequiredException(m, httpStatus, details);
    }
}

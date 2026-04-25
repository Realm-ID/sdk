package dev.realmid.sdk;

/**
 * Thrown by {@link Verifier#verify(String)} when verification fails.
 * The {@link #getCode()} value is the stable, language-neutral failure id.
 */
public class VerifyException extends RuntimeException {
    private final ErrorCode code;

    public VerifyException(ErrorCode code, String message) {
        super(message);
        this.code = code;
    }

    public VerifyException(ErrorCode code, String message, Throwable cause) {
        super(message, cause);
        this.code = code;
    }

    public ErrorCode getCode() {
        return code;
    }
}

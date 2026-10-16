package dev.realmid.sdk.me;

/**
 * Input to {@link MeClient#setPassword} ({@code PUT /me/password}, ADR-104).
 * {@code currentPassword} is required when a password already exists and is omitted on a first
 * set (null or empty is not sent). Both are secrets: {@link #toString} prints neither.
 */
public record SetPasswordRequest(String currentPassword, String newPassword) {
    /** A first set (no current password). */
    public static SetPasswordRequest of(String newPassword) {
        return new SetPasswordRequest(null, newPassword);
    }

    /** A change: the current password and its replacement. */
    public static SetPasswordRequest change(String currentPassword, String newPassword) {
        return new SetPasswordRequest(currentPassword, newPassword);
    }

    @Override
    public String toString() {
        return "SetPasswordRequest[redacted]";
    }
}

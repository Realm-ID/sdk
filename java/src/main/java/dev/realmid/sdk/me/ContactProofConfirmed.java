package dev.realmid.sdk.me;

import java.time.Instant;

/** Answer of {@link MeClient#confirmContactProof}: the contact, now proven. {@code verifiedAt} is null if the issuer sent none. */
public record ContactProofConfirmed(String id, String kind, String value, boolean verified, Instant verifiedAt) {
    /** Omits {@code value}: a phone number is personal data and does not belong in a log line. */
    @Override
    public String toString() {
        return "ContactProofConfirmed[id=" + id + ", kind=" + kind + ", verified=" + verified + ", verifiedAt=" + verifiedAt + "]";
    }
}

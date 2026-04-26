package dev.realmid.sdk;

import java.util.Collections;
import java.util.List;
import java.util.Map;

/**
 * Verified token payload. Standard JWT fields plus the RealmID-specific
 * extras (azp, tenantId, role). Unknown fields land in {@link #extra}.
 */
public final class Claims {
    private final String issuer;
    private final String subject;
    private final String audience;
    private final long issuedAt;
    private final long notBefore;
    private final long expiry;
    private final String jwtId;
    private final String authorizedParty;
    private final String tenantId;
    private final String role;
    private final long mfaAt;
    private final Map<String, Object> extra;

    /** Backward-compat overload — leaves {@code mfaAt} as 0 (absent). */
    public Claims(
            String issuer,
            String subject,
            String audience,
            long issuedAt,
            long notBefore,
            long expiry,
            String jwtId,
            String authorizedParty,
            String tenantId,
            String role,
            Map<String, Object> extra) {
        this(issuer, subject, audience, issuedAt, notBefore, expiry, jwtId,
                authorizedParty, tenantId, role, 0L, extra);
    }

    public Claims(
            String issuer,
            String subject,
            String audience,
            long issuedAt,
            long notBefore,
            long expiry,
            String jwtId,
            String authorizedParty,
            String tenantId,
            String role,
            long mfaAt,
            Map<String, Object> extra) {
        this.issuer = issuer;
        this.subject = subject;
        this.audience = audience;
        this.issuedAt = issuedAt;
        this.notBefore = notBefore;
        this.expiry = expiry;
        this.jwtId = jwtId;
        this.authorizedParty = authorizedParty;
        this.tenantId = tenantId;
        this.role = role;
        this.mfaAt = mfaAt;
        this.extra = extra == null ? Collections.emptyMap() : Collections.unmodifiableMap(extra);
    }

    public String issuer() { return issuer; }
    public String subject() { return subject; }
    public String audience() { return audience; }
    public long issuedAt() { return issuedAt; }
    public long notBefore() { return notBefore; }
    public long expiry() { return expiry; }
    public String jwtId() { return jwtId; }
    public String authorizedParty() { return authorizedParty; }
    public String tenantId() { return tenantId; }
    public String role() { return role; }

    /**
     * Unix-seconds of the user's most recent successful MFA challenge
     * (SPEC §10.4). 0 means MFA never verified for this session.
     */
    public long mfaAt() { return mfaAt; }

    /** Custom (non-reserved) claims as a read-only map. */
    public Map<String, Object> extra() { return extra; }

    /**
     * Legacy MFA marker check — true when the token carries an
     * {@code amr} array containing {@code "mfa"} or
     * {@code acr == "urn:realmid:mfa"}. Useful as a fallback for tokens
     * minted before {@link #mfaAt()} was introduced. New gates should
     * prefer {@link #mfaAt()} for proof of freshness.
     */
    public boolean hasMfa() {
        Object amr = extra.get("amr");
        if (amr instanceof List<?> list) {
            for (Object x : list) {
                if ("mfa".equals(String.valueOf(x))) return true;
            }
        }
        Object acr = extra.get("acr");
        return "urn:realmid:mfa".equals(acr);
    }
}

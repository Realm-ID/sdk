package dev.realmid.sdk;

import java.util.Collections;
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
    private final Map<String, Object> extra;

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

    /** Custom (non-reserved) claims as a read-only map. */
    public Map<String, Object> extra() { return extra; }
}

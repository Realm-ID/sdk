package dev.realmid.sdk.auth;

import java.util.function.LongSupplier;

/**
 * Construction options for {@link TokenManager} (SPEC §4.2.1). All fields are
 * optional; use the fluent setters or the canonical constructor.
 */
public final class TokenManagerOptions {

    private String tenantId;
    private RefreshSink refreshSink;
    private LongSupplier clock;

    public TokenManagerOptions() {}

    /**
     * Tenant id sent on each {@code /auth/token} (required for multi-tenant
     * user refresh tokens; ignored otherwise).
     */
    public TokenManagerOptions tenantId(String v) { this.tenantId = v; return this; }

    /** Durable sink for rotated refresh tokens. See {@link RefreshSink}. */
    public TokenManagerOptions refreshSink(RefreshSink v) { this.refreshSink = v; return this; }

    /** Clock override (tests only). Returns epoch milliseconds. */
    public TokenManagerOptions clock(LongSupplier v) { this.clock = v; return this; }

    public String tenantId() { return tenantId; }
    public RefreshSink refreshSink() { return refreshSink; }
    public LongSupplier clock() { return clock; }
}

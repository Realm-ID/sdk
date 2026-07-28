package dev.realmid.sdk.middleware;

import dev.realmid.sdk.Realm;

import java.time.Duration;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

/** SPEC §10.2 configuration. */
public final class MiddlewareConfig {

    final Realm realm;
    final List<String> exemptPaths;
    final List<MFARule> mfaProtectedPaths;
    final Duration mfaDefaultMaxAge;
    final String loginPath;
    final String logoutPath;
    final String refreshPath;
    final String mfaVerifyPath;
    final TokenDelivery tokenDelivery;
    final String cookieName;
    /**
     * Cookie Domain attribute for the refresh cookie, or null for host-only.
     *
     * <p><b>Changing this on a live deployment strands existing sessions</b>
     * unless you also set {@code cookieDomainMigrateFrom}. Per RFC 6265 a
     * Set-Cookie carrying a Domain attribute cannot overwrite a host-only
     * cookie of the same name — they are separate jar entries — so every
     * browser already holding one ends up with two, only one of which is
     * rotated from then on.
     */
    final String cookieDomain;
    /**
     * Cookie scopes this deployment PREVIOUSLY wrote the refresh cookie at, so
     * they can be actively evicted instead of shadowing the live one forever.
     * Use the empty string for the host-only scope.
     *
     * <p>Needed when TIGHTENING or REMOVING a domain, because the old, wider
     * cookie is invisible to a configuration that no longer writes it.
     * Widening is handled for free: setting {@code cookieDomain} always evicts
     * the host-only twin.
     */
    final List<String> cookieDomainMigrateFrom;
    final boolean cookieSecure;
    final String cookieSameSite;

    private MiddlewareConfig(Builder b) {
        this.realm = b.realm;
        this.exemptPaths = Collections.unmodifiableList(new ArrayList<>(b.exemptPaths));
        this.mfaProtectedPaths = Collections.unmodifiableList(new ArrayList<>(b.mfaProtectedPaths));
        this.mfaDefaultMaxAge = b.mfaDefaultMaxAge;
        this.loginPath = b.loginPath;
        this.logoutPath = b.logoutPath;
        this.refreshPath = b.refreshPath;
        this.mfaVerifyPath = b.mfaVerifyPath;
        this.tokenDelivery = b.tokenDelivery;
        this.cookieName = b.cookieName;
        this.cookieDomain = b.cookieDomain;
        this.cookieDomainMigrateFrom =
                Collections.unmodifiableList(new ArrayList<>(b.cookieDomainMigrateFrom));
        this.cookieSecure = b.cookieSecure;
        this.cookieSameSite = b.cookieSameSite;
    }

    public Realm realm() { return realm; }
    public List<String> exemptPaths() { return exemptPaths; }
    public List<MFARule> mfaProtectedPaths() { return mfaProtectedPaths; }
    public Duration mfaDefaultMaxAge() { return mfaDefaultMaxAge; }
    public String loginPath() { return loginPath; }
    public String logoutPath() { return logoutPath; }
    public String refreshPath() { return refreshPath; }
    public String mfaVerifyPath() { return mfaVerifyPath; }
    public TokenDelivery tokenDelivery() { return tokenDelivery; }
    public String cookieName() { return cookieName; }
    public String cookieDomain() { return cookieDomain; }
    public List<String> cookieDomainMigrateFrom() { return cookieDomainMigrateFrom; }
    public boolean cookieSecure() { return cookieSecure; }
    public String cookieSameSite() { return cookieSameSite; }

    public static final class Builder {
        private final Realm realm;
        private List<String> exemptPaths = new ArrayList<>(Arrays.asList("/health", "/public/*"));
        private List<MFARule> mfaProtectedPaths = new ArrayList<>();
        private Duration mfaDefaultMaxAge = Duration.ofMinutes(15);
        private String loginPath = "/login";
        private String logoutPath = "/logout";
        private String refreshPath = "/token";
        private String mfaVerifyPath = "/mfa/verify";
        private TokenDelivery tokenDelivery = TokenDelivery.COOKIE;
        private String cookieName = "realmid_refresh";
        private String cookieDomain;
        private List<String> cookieDomainMigrateFrom = new ArrayList<>();
        private boolean cookieSecure = true;
        private String cookieSameSite = "Lax";

        public Builder(Realm realm) { this.realm = realm; }

        public Builder exemptPaths(List<String> v) {
            this.exemptPaths = v == null ? new ArrayList<>() : new ArrayList<>(v);
            return this;
        }

        /** SPEC §10.4 — per-route MFA freshness policies. */
        public Builder mfaProtectedPaths(List<MFARule> v) {
            this.mfaProtectedPaths = v == null ? new ArrayList<>() : new ArrayList<>(v);
            return this;
        }

        /**
         * Backward-compat sugar: bare path strings, each wrapped into a
         * default {@link MFARule} that inherits the realm-default
         * freshness window.
         */
        public Builder mfaProtectedPaths(String... paths) {
            ArrayList<MFARule> rules = new ArrayList<>();
            if (paths != null) {
                for (String p : paths) rules.add(MFARule.of(p));
            }
            this.mfaProtectedPaths = rules;
            return this;
        }

        /**
         * Realm-wide default freshness window applied to {@link MFARule}
         * entries that omit {@code maxAge}. Default 15 min. Mirrors
         * {@code realms.config.mfa_session_ttl_seconds} server-side.
         */
        public Builder mfaDefaultMaxAge(Duration v) {
            this.mfaDefaultMaxAge = v == null ? Duration.ofMinutes(15) : v;
            return this;
        }

        public Builder loginPath(String v) { this.loginPath = v; return this; }
        public Builder logoutPath(String v) { this.logoutPath = v; return this; }
        public Builder refreshPath(String v) { this.refreshPath = v; return this; }
        public Builder mfaVerifyPath(String v) { this.mfaVerifyPath = v; return this; }
        public Builder tokenDelivery(TokenDelivery v) { this.tokenDelivery = v; return this; }
        public Builder cookieName(String v) { this.cookieName = v; return this; }
        public Builder cookieDomain(String v) { this.cookieDomain = v; return this; }
        public Builder cookieDomainMigrateFrom(List<String> v) {
            this.cookieDomainMigrateFrom = new ArrayList<>(v);
            return this;
        }
        public Builder cookieSecure(boolean v) { this.cookieSecure = v; return this; }
        public Builder cookieSameSite(String v) { this.cookieSameSite = v; return this; }

        public MiddlewareConfig build() {
            return new MiddlewareConfig(this);
        }

        public RealmFilter buildFilter() {
            return new RealmFilter(build());
        }
    }
}

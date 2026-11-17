package dev.realmid.sdk.middleware;

import dev.realmid.sdk.Realm;

import java.time.Duration;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.function.Function;

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
    /** SPEC 10.1 step 5a: the recovery-code route. NO default; null or empty = route off. */
    final String recoveryPath;
    /** The end user's IP for X-On-Behalf-Of-IP on MFA verify/recovery (SPEC 10.1 steps 5, 5a); null = getRemoteAddr(). */
    final Function<jakarta.servlet.http.HttpServletRequest, String> clientIp;
    final TokenDelivery tokenDelivery;
    /** SPEC 10.5 Origin guard mode; never null. */
    final OriginEnforcement originEnforcement;
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
    /** SPEC 10.1 step 4a: loser poll interval and tries (50 ms x 60 = the 3 s budget). */
    final long refreshPollMillis;
    final int refreshPollTries;

    private MiddlewareConfig(Builder b) {
        this.refreshPollMillis = b.refreshPollMillis;
        this.refreshPollTries = b.refreshPollTries;
        this.realm = b.realm;
        this.exemptPaths = Collections.unmodifiableList(new ArrayList<>(b.exemptPaths));
        this.mfaProtectedPaths = Collections.unmodifiableList(new ArrayList<>(b.mfaProtectedPaths));
        this.mfaDefaultMaxAge = b.mfaDefaultMaxAge;
        this.loginPath = b.loginPath;
        this.logoutPath = b.logoutPath;
        this.refreshPath = b.refreshPath;
        this.mfaVerifyPath = b.mfaVerifyPath;
        this.recoveryPath = b.recoveryPath;
        this.clientIp = b.clientIp;
        this.tokenDelivery = b.tokenDelivery;
        this.originEnforcement = b.originEnforcement;
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
    /** The recovery-code route, or null when it is off (the default). */
    public String recoveryPath() { return recoveryPath; }
    /** The end-user IP hook, or null for the container's {@code getRemoteAddr()}. */
    public Function<jakarta.servlet.http.HttpServletRequest, String> clientIp() { return clientIp; }
    public TokenDelivery tokenDelivery() { return tokenDelivery; }
    public OriginEnforcement originEnforcement() { return originEnforcement; }
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
        private String recoveryPath;
        private Function<jakarta.servlet.http.HttpServletRequest, String> clientIp;
        private TokenDelivery tokenDelivery = TokenDelivery.COOKIE;
        private OriginEnforcement originEnforcement = OriginEnforcement.AUTO;
        private String cookieName = "realmid_refresh";
        private String cookieDomain;
        private List<String> cookieDomainMigrateFrom = new ArrayList<>();
        private boolean cookieSecure = true;
        private String cookieSameSite = "Lax";
        private long refreshPollMillis = 50;
        private int refreshPollTries = 60;

        /** Test hook: shortens the refresh-loser wait. The spec values (50 ms x 60) are the default. */
        Builder refreshWait(long pollMillis, int tries) {
            this.refreshPollMillis = pollMillis;
            this.refreshPollTries = tries;
            return this;
        }

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
        /**
         * Mounts the recovery-code redeem route (SPEC 10.1 step 5a). OPT-IN with NO default
         * (owner ruling 2026-10-02): a partner that does not use recovery codes must not get a
         * route it never asked for. Takes the same per-session lock as the MFA-verify route.
         */
        public Builder recoveryPath(String v) { this.recoveryPath = v; return this; }
        /**
         * The END USER's IP, forwarded as {@code X-On-Behalf-Of-IP} on the MFA verify and recovery
         * calls (SPEC 10.1 steps 5, 5a) so the issuer's per-IP limiter counts the user, not this
         * server's egress IP. Default {@code getRemoteAddr()}. Behind a proxy, supply it: the SDK
         * never trusts {@code X-Forwarded-For} itself.
         */
        public Builder clientIp(Function<jakarta.servlet.http.HttpServletRequest, String> v) { this.clientIp = v; return this; }
        public Builder tokenDelivery(TokenDelivery v) { this.tokenDelivery = v; return this; }
        /** SPEC 10.5: the Origin guard mode; default {@link OriginEnforcement#AUTO}. */
        public Builder originEnforcement(OriginEnforcement v) {
            this.originEnforcement = v == null ? OriginEnforcement.AUTO : v;
            return this;
        }
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

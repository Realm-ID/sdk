package dev.realmid.sdk.middleware;

import dev.realmid.sdk.Realm;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

/** SPEC §10.2 configuration. */
public final class MiddlewareConfig {

    final Realm realm;
    final List<String> exemptPaths;
    final List<String> mfaProtectedPaths;
    final String loginPath;
    final String logoutPath;
    final String refreshPath;
    final String mfaVerifyPath;
    final TokenDelivery tokenDelivery;
    final String cookieName;
    final String cookieDomain;
    final boolean cookieSecure;
    final String cookieSameSite;

    private MiddlewareConfig(Builder b) {
        this.realm = b.realm;
        this.exemptPaths = Collections.unmodifiableList(new ArrayList<>(b.exemptPaths));
        this.mfaProtectedPaths = Collections.unmodifiableList(new ArrayList<>(b.mfaProtectedPaths));
        this.loginPath = b.loginPath;
        this.logoutPath = b.logoutPath;
        this.refreshPath = b.refreshPath;
        this.mfaVerifyPath = b.mfaVerifyPath;
        this.tokenDelivery = b.tokenDelivery;
        this.cookieName = b.cookieName;
        this.cookieDomain = b.cookieDomain;
        this.cookieSecure = b.cookieSecure;
        this.cookieSameSite = b.cookieSameSite;
    }

    public Realm realm() { return realm; }
    public List<String> exemptPaths() { return exemptPaths; }
    public List<String> mfaProtectedPaths() { return mfaProtectedPaths; }
    public String loginPath() { return loginPath; }
    public String logoutPath() { return logoutPath; }
    public String refreshPath() { return refreshPath; }
    public String mfaVerifyPath() { return mfaVerifyPath; }
    public TokenDelivery tokenDelivery() { return tokenDelivery; }
    public String cookieName() { return cookieName; }
    public String cookieDomain() { return cookieDomain; }
    public boolean cookieSecure() { return cookieSecure; }
    public String cookieSameSite() { return cookieSameSite; }

    public static final class Builder {
        private final Realm realm;
        private List<String> exemptPaths = new ArrayList<>(Arrays.asList("/health", "/public/*"));
        private List<String> mfaProtectedPaths = new ArrayList<>();
        private String loginPath = "/login";
        private String logoutPath = "/logout";
        private String refreshPath = "/token";
        private String mfaVerifyPath = "/mfa/verify";
        private TokenDelivery tokenDelivery = TokenDelivery.COOKIE;
        private String cookieName = "realmid_refresh";
        private String cookieDomain;
        private boolean cookieSecure = true;
        private String cookieSameSite = "Lax";

        public Builder(Realm realm) { this.realm = realm; }

        public Builder exemptPaths(List<String> v) {
            this.exemptPaths = v == null ? new ArrayList<>() : new ArrayList<>(v);
            return this;
        }
        public Builder mfaProtectedPaths(List<String> v) {
            this.mfaProtectedPaths = v == null ? new ArrayList<>() : new ArrayList<>(v);
            return this;
        }
        public Builder loginPath(String v) { this.loginPath = v; return this; }
        public Builder logoutPath(String v) { this.logoutPath = v; return this; }
        public Builder refreshPath(String v) { this.refreshPath = v; return this; }
        public Builder mfaVerifyPath(String v) { this.mfaVerifyPath = v; return this; }
        public Builder tokenDelivery(TokenDelivery v) { this.tokenDelivery = v; return this; }
        public Builder cookieName(String v) { this.cookieName = v; return this; }
        public Builder cookieDomain(String v) { this.cookieDomain = v; return this; }
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

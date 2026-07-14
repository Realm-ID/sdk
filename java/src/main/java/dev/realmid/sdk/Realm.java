package dev.realmid.sdk;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.realmid.sdk.apikeys.APIKeysClient;
import dev.realmid.sdk.auth.AuthClient;
import dev.realmid.sdk.domains.DomainsClient;
import dev.realmid.sdk.http.HttpTransport;
import dev.realmid.sdk.info.ConfigClient;
import dev.realmid.sdk.info.RealmInfo;
import dev.realmid.sdk.info.RealmInfoClient;
import dev.realmid.sdk.middleware.MiddlewareConfig;
import dev.realmid.sdk.origins.OriginsClient;
import dev.realmid.sdk.otp.OtpClient;
import dev.realmid.sdk.platformtoken.CredentialSource;
import dev.realmid.sdk.platformtoken.CredentialSources;
import dev.realmid.sdk.platformtoken.PlatformTokenManager;
import dev.realmid.sdk.idp.IdentityProviderConfigClient;
import dev.realmid.sdk.roles.RolesClient;
import dev.realmid.sdk.serviceaccounts.ServiceAccountsClient;
import dev.realmid.sdk.signingkeys.SigningKeysClient;
import dev.realmid.sdk.sources.SourcesClient;
import dev.realmid.sdk.tenants.TenantsClient;
import dev.realmid.sdk.tokens.TokensClient;
import dev.realmid.sdk.admin.AdminClient;
import dev.realmid.sdk.auditevents.AuditEventsClient;
import dev.realmid.sdk.verifier.Verifier;

import java.lang.System.Logger;
import java.net.http.HttpClient;
import java.time.Clock;
import java.time.Duration;

/**
 * Top-level handle (SPEC §1). Construct with {@link #builder()}.
 */
public final class Realm {

    static final String DEFAULT_BASE_URL = "https://auth.realmid.dev";

    private final String realmId;
    private final String baseUrl;
    private final String origin;
    private final Logger logger;
    private final HttpTransport http;
    private final Verifier verifier;
    private final AuthClient auth;
    private final OtpClient otp;
    private final TenantsClient tenants;
    private final DomainsClient domains;
    private final APIKeysClient apiKeys;
    private final RolesClient roles;
    private final ServiceAccountsClient serviceAccounts;
    private final SourcesClient sources;
    private final SigningKeysClient signingKeys;
    private final IdentityProviderConfigClient identityProviderConfig;
    private final OriginsClient origins;
    private final TokensClient tokens;
    private final AdminClient admin;
    private final AuditEventsClient auditEvents;
    private final RealmInfoClient info;
    private final ConfigClient config;
    private final PlatformTokenManager platformTokens;

    private Realm(Builder b) {
        if (b.realmId == null || b.realmId.isEmpty()) {
            throw new RealmException(ErrorCode.BAD_REQUEST, "realmid: realmId required");
        }
        this.realmId = b.realmId;
        this.baseUrl = stripSlash(b.baseUrl == null ? DEFAULT_BASE_URL : b.baseUrl);
        this.origin = b.origin;
        this.logger = b.logger == null ? Logging.NOOP : b.logger;
        ObjectMapper mapper = b.mapper == null ? new ObjectMapper() : b.mapper;
        HttpClient httpClient = b.httpClient == null
                ? HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1).build()
                : b.httpClient;
        Clock clock = b.clock == null ? Clock.systemUTC() : b.clock;

        // Resolve the bootstrap credential (ADR-057): explicit credential wins;
        // else a static apiKey; else auto-detect an ambient workload identity.
        CredentialSource credential = b.credential != null
                ? b.credential
                : (b.apiKey != null && !b.apiKey.isEmpty()
                        ? CredentialSources.staticApiKey(b.apiKey)
                        : CredentialSources.autoDetect(CredentialSources.DEFAULT_FEDERATION_AUDIENCE, httpClient, mapper));

        this.platformTokens = new PlatformTokenManager(
                credential, this.baseUrl, httpClient, mapper, this.logger, clock,
                b.refreshSkew == null ? Duration.ofSeconds(30) : b.refreshSkew);
        this.http = new HttpTransport(this.baseUrl, httpClient, mapper, this.logger, this.platformTokens);

        this.info = new RealmInfoClient(this.http, this.realmId, true);
        this.verifier = new Verifier(
                this.baseUrl,
                b.audience,
                b.audience != null ? null : (rid -> {
                    RealmInfo i = this.info.info();
                    return i == null ? null : i.audience();
                }),
                httpClient, mapper,
                b.cacheTtl, b.leeway, clock, this.logger);
        this.auth = new AuthClient(this.http, this.realmId, this::resolveOrigin);
        this.otp = new OtpClient(this.http);
        this.tenants = new TenantsClient(this.http);
        this.domains = new DomainsClient(this.http);
        this.apiKeys = new APIKeysClient(this.http, this.realmId);
        this.roles = new RolesClient(this.http, this.realmId);
        this.serviceAccounts = new ServiceAccountsClient(this.http);
        this.sources = new SourcesClient(this.http, this.realmId);
        this.signingKeys = new SigningKeysClient(this.http, this.realmId);
        this.identityProviderConfig = new IdentityProviderConfigClient(this.http, this.realmId);
        this.origins = new OriginsClient(this.http, this.platformTokens, clock);
        this.tokens = new TokensClient(clock);
        this.admin = new AdminClient(this.http);
        this.auditEvents = new AuditEventsClient(this.http, this.realmId);
        this.config = new ConfigClient(this.http, this.realmId);
    }

    public String realmId() { return realmId; }
    public String baseUrl() { return baseUrl; }
    public Logger logger() { return logger; }

    /** SPEC §5 — verify. */
    public Claims verify(String token) { return verifier.verify(token); }
    public Claims verify(String token, VerifyOptions opts) {
        return verifier.verify(token, opts == null ? null : opts.audience());
    }

    public AuthClient auth() { return auth; }
    /** SPEC §X — partner OTP primitive (issue / view / verify). */
    public OtpClient otp() { return otp; }
    public TenantsClient tenants() { return tenants; }
    public DomainsClient domains() { return domains; }
    public APIKeysClient apiKeys() { return apiKeys; }
    public RolesClient roles() { return roles; }
    /** Owner/admin service-account surface (ADR-071). */
    public ServiceAccountsClient serviceAccounts() { return serviceAccounts; }
    /** Owner/admin app/source registry (ADR-072). */
    public SourcesClient sources() { return sources; }
    /** Owner-facing signing-key read + self-serve rotate (roles/signing-keys overhaul). */
    public SigningKeysClient signingKeys() { return signingKeys; }
    /** Identity-provider config CRUD (admin resource; distinct from IdP discovery). */
    public IdentityProviderConfigClient identityProviderConfig() { return identityProviderConfig; }
    public OriginsClient origins() { return origins; }
    /** SPEC §6.7 — access-token revocation cache. */
    public TokensClient tokens() { return tokens; }
    /** SPEC §7.5 — admin aggregates surface (ADR-048). */
    public AdminClient admin() { return admin; }
    /** SPEC §7.6 — partner audit-event feed (ADR-055). */
    public AuditEventsClient auditEvents() { return auditEvents; }
    public ConfigClient config() { return config; }
    public RealmInfo info() { return info.info(); }

    /** Test-only / advanced: clear the cached realm info and audience. */
    public void invalidateInfo() { info.invalidate(); }

    /** Internal accessor for the middleware. */
    public HttpTransport http() { return http; }
    public PlatformTokenManager platformTokens() { return platformTokens; }

    /** SPEC §10 — middleware config builder. */
    public MiddlewareConfig.Builder middleware() {
        return new MiddlewareConfig.Builder(this);
    }

    private String resolveOrigin() {
        if (origin != null && !origin.isEmpty()) return origin;
        try {
            RealmInfo i = info.info();
            if (i == null || i.audience() == null || i.audience().isEmpty()) return null;
            String aud = i.audience();
            if (aud.startsWith("http://") || aud.startsWith("https://")) return aud;
            return "https://" + aud;
        } catch (RuntimeException ignored) {
            return null;
        }
    }

    public static Builder builder() { return new Builder(); }

    private static String stripSlash(String s) {
        int end = s.length();
        while (end > 0 && s.charAt(end - 1) == '/') end--;
        return s.substring(0, end);
    }

    /** SPEC §5 — verify options (per-call audience override). */
    public record VerifyOptions(String audience) {}

    public static final class Builder {
        private String realmId;
        private String apiKey;
        private CredentialSource credential;
        private String baseUrl;
        private String origin;
        private String audience;
        private Logger logger;
        private HttpClient httpClient;
        private ObjectMapper mapper;
        private Clock clock;
        private Duration cacheTtl;
        private Duration leeway;
        private Duration refreshSkew;

        public Builder realmId(String v) { this.realmId = v; return this; }
        public Builder apiKey(String v) { this.apiKey = v; return this; }
        /** Workload identity federation credential source (ADR-057). Overrides apiKey. */
        public Builder credential(CredentialSource v) { this.credential = v; return this; }
        public Builder baseUrl(String v) { this.baseUrl = v; return this; }
        public Builder origin(String v) { this.origin = v; return this; }
        public Builder audience(String v) { this.audience = v; return this; }
        public Builder logger(Logger v) { this.logger = v; return this; }
        public Builder httpClient(HttpClient v) { this.httpClient = v; return this; }
        public Builder mapper(ObjectMapper v) { this.mapper = v; return this; }
        public Builder clock(Clock v) { this.clock = v; return this; }
        public Builder cacheTtl(Duration v) { this.cacheTtl = v; return this; }
        public Builder leeway(Duration v) { this.leeway = v; return this; }
        public Builder refreshSkew(Duration v) { this.refreshSkew = v; return this; }

        public Realm build() { return new Realm(this); }
    }
}

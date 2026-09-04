package dev.realmid.sdk;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.realmid.sdk.apikeys.APIKeysClient;
import dev.realmid.sdk.userapikeys.UserAPIKeysClient;
import dev.realmid.sdk.auth.AuthClient;
import dev.realmid.sdk.domains.DomainsClient;
import dev.realmid.sdk.federation.FederationBindingsClient;
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
import dev.realmid.sdk.idp.IdentityProvidersClient;
import dev.realmid.sdk.roles.RolesClient;
import dev.realmid.sdk.roles.RoleTemplatesClient;
import dev.realmid.sdk.serviceaccounts.ServiceAccountsClient;
import dev.realmid.sdk.integrations.IntegrationsClient;
import dev.realmid.sdk.sessions.SessionsClient;
import dev.realmid.sdk.me.MeClient;
import dev.realmid.sdk.signingkeys.SigningKeysClient;
import dev.realmid.sdk.stats.StatsClient;
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
    /**
     * ADR-102 — the partner role-name resolver, carried so a withUserToken copy
     * keeps it. A copy that dropped it would silently stop minting the claim on
     * exactly the BFF lane the claim exists for.
     */
    private final dev.realmid.sdk.auth.ProductRolesHandler productRoles;
    /**
     * ADR-097 — the partner scope resolver, carried for the same reason
     * productRoles is: a withUserToken copy that dropped it would stop minting
     * granted authority on exactly the BFF lane the claim exists for.
     */
    private final dev.realmid.sdk.auth.ScopesHandler scopes;
    private final OtpClient otp;
    private final TenantsClient tenants;
    private final DomainsClient domains;
    private final APIKeysClient apiKeys;
    private final UserAPIKeysClient userApiKeys;
    private final RolesClient roles;
    /**
     * RealmID's role VOCABULARY (ADR-101 D1), not one realm's roles.
     * Base-realm-gated: a partner realm gets {@code role_authoring_retired}.
     */
    private final RoleTemplatesClient roleTemplates;
    private final ServiceAccountsClient serviceAccounts;
    private final IntegrationsClient integrations;
    private final SourcesClient sources;
    private final FederationBindingsClient federationBindings;
    private final SigningKeysClient signingKeys;
    private final IdentityProviderConfigClient identityProviderConfig;
    private final IdentityProvidersClient identityProviders;
    private final OriginsClient origins;
    private final TokensClient tokens;
    private final AdminClient admin;
    private final AuditEventsClient auditEvents;
    private final SessionsClient sessions;
    private final MeClient me;
    private final RealmInfoClient info;
    private final ConfigClient config;
    private final StatsClient stats;
    private final PlatformTokenManager platformTokens;
    private final Clock clock;
    private final dev.realmid.sdk.authority.AuthorityCache authority;

    private Realm(Builder b) {
        if (b.realmId == null || b.realmId.isEmpty()) {
            throw new RealmException(ErrorCode.BAD_REQUEST, "realmid: realmId required");
        }
        this.realmId = b.realmId;
        this.baseUrl = stripSlash(b.baseUrl == null ? DEFAULT_BASE_URL : b.baseUrl);
        this.origin = b.origin;
        this.logger = b.logger == null ? Logging.NOOP : b.logger;
        this.productRoles = b.productRoles;
        this.scopes = b.scopes;
        ObjectMapper mapper = b.mapper == null ? new ObjectMapper() : b.mapper;
        HttpClient httpClient = b.httpClient == null
                ? HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1).build()
                : b.httpClient;
        Clock clock = b.clock == null ? Clock.systemUTC() : b.clock;
        this.clock = clock;

        // Resolve the bootstrap credential (ADR-057): explicit credential wins;
        // else a static apiKey; else auto-detect an ambient workload identity.
        CredentialSource credential = b.credential != null
                ? b.credential
                : (b.apiKey != null && !b.apiKey.isEmpty()
                        ? CredentialSources.staticApiKey(b.apiKey)
                        : CredentialSources.autoDetect(CredentialSources.DEFAULT_FEDERATION_AUDIENCE, httpClient, mapper));

        this.platformTokens = new PlatformTokenManager(
                credential, this.baseUrl, httpClient, mapper, this.logger, clock,
                b.refreshSkew == null ? Duration.ofSeconds(30) : b.refreshSkew,
                // ADR-041 realm pin: the manager refuses a platform token whose
                // iss belongs to a different realm than the one configured here.
                this.realmId);
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
                b.cacheTtl, b.leeway, clock, this.logger, b.authority);
        this.authority = b.authority;
        this.auth = new AuthClient(this.http, this.realmId, this::resolveOrigin, this.productRoles, this.scopes);
        this.otp = new OtpClient(this.http);
        this.tenants = new TenantsClient(this.http, this.realmId);
        this.domains = new DomainsClient(this.http);
        this.apiKeys = new APIKeysClient(this.http, this.realmId);
        this.userApiKeys = new UserAPIKeysClient(this.http);
        this.roles = new RolesClient(this.http, this.realmId);
        this.roleTemplates = new RoleTemplatesClient(this.http, this.realmId);
        this.serviceAccounts = new ServiceAccountsClient(this.http);
        this.sources = new SourcesClient(this.http, this.realmId);
        this.integrations = new IntegrationsClient(this.http, this.realmId);
        this.federationBindings = new FederationBindingsClient(this.http, this.realmId);
        this.signingKeys = new SigningKeysClient(this.http, this.realmId);
        this.identityProviderConfig = new IdentityProviderConfigClient(this.http, this.realmId);
        this.identityProviders = new IdentityProvidersClient(this.http, this.realmId);
        this.origins = new OriginsClient(this.http, this.platformTokens, clock);
        this.tokens = new TokensClient(clock);
        this.admin = new AdminClient(this.http);
        this.auditEvents = new AuditEventsClient(this.http, this.realmId);
        this.sessions = new SessionsClient(this.http, this.realmId);
        this.me = new MeClient(this.http);
        this.config = new ConfigClient(this.http, this.realmId);
        this.stats = new StatsClient(this.http, this.realmId);
    }

    /**
     * Derivation constructor for {@link #withUserToken(String)} — the whole
     * resource bundle is rebuilt around a transport that carries the user JWT,
     * which is what reaches every typed method without changing a single
     * signature. Everything expensive is SHARED with the parent: the
     * platform-token manager and its cache, the verifier and its JWKS cache,
     * and realm-info discovery (all platform-scoped, none of them user-scoped),
     * so deriving per request is cheap.
     */
    private Realm(Realm parent, String userToken) {
        this.realmId = parent.realmId;
        this.baseUrl = parent.baseUrl;
        this.origin = parent.origin;
        this.logger = parent.logger;
        this.productRoles = parent.productRoles;
        this.scopes = parent.scopes;
        this.clock = parent.clock;
        this.authority = parent.authority;
        this.platformTokens = parent.platformTokens;
        this.info = parent.info;
        this.verifier = parent.verifier;
        this.http = parent.http.withUserToken(userToken);

        this.auth = new AuthClient(this.http, this.realmId, this::resolveOrigin, this.productRoles, this.scopes);
        this.otp = new OtpClient(this.http);
        this.tenants = new TenantsClient(this.http, this.realmId);
        this.domains = new DomainsClient(this.http);
        this.apiKeys = new APIKeysClient(this.http, this.realmId);
        this.userApiKeys = new UserAPIKeysClient(this.http);
        this.roles = new RolesClient(this.http, this.realmId);
        this.roleTemplates = new RoleTemplatesClient(this.http, this.realmId);
        this.serviceAccounts = new ServiceAccountsClient(this.http);
        this.sources = new SourcesClient(this.http, this.realmId);
        this.integrations = new IntegrationsClient(this.http, this.realmId);
        this.federationBindings = new FederationBindingsClient(this.http, this.realmId);
        this.signingKeys = new SigningKeysClient(this.http, this.realmId);
        this.identityProviderConfig = new IdentityProviderConfigClient(this.http, this.realmId);
        this.identityProviders = new IdentityProvidersClient(this.http, this.realmId);
        this.origins = new OriginsClient(this.http, this.platformTokens, this.clock);
        this.tokens = new TokensClient(this.clock);
        this.admin = new AdminClient(this.http);
        this.auditEvents = new AuditEventsClient(this.http, this.realmId);
        this.sessions = new SessionsClient(this.http, this.realmId);
        this.me = new MeClient(this.http);
        this.config = new ConfigClient(this.http, this.realmId);
        this.stats = new StatsClient(this.http, this.realmId);
    }

    /**
     * Returns a DERIVED realm whose every call carries {@code accessJWT} as
     * {@code X-User-Token} — the on-behalf-of mode a BFF needs (SPEC §4
     * verified on-behalf-of; ADR-056). The realm's platform token stays the
     * wire bearer; the user JWT
     * is additive, so the issuer authorizes a <em>verified</em> principal
     * rather than trusting a bare user id (which it refuses outright since
     * v0.66.0).
     *
     * <pre>{@code
     * Realm asUser = realm.withUserToken(session.accessToken());
     * asUser.tenants().list();
     * }</pre>
     *
     * Derivation rather than a mutable field is deliberate — this SDK targets
     * virtual threads, where a ThreadLocal ambient token is fragile, and a
     * request-scoped identity must never be pinned onto the long-lived handle.
     * The SDK stores nothing: persistence and refresh of the user JWT stay the
     * caller's responsibility.
     */
    public Realm withUserToken(String accessJWT) {
        if (accessJWT == null || accessJWT.isEmpty()) {
            throw new RealmException(ErrorCode.BAD_REQUEST, "realmid: withUserToken requires a non-empty access token");
        }
        return new Realm(this, accessJWT);
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

    /**
     * ADR-084 end-user API keys (SPEC §6.6). Separate from {@link #apiKeys()} by
     * design: an org admin managing members' keys must not thereby gain
     * platform-key power.
     */
    public UserAPIKeysClient userApiKeys() { return userApiKeys; }
    public RolesClient roles() { return roles; }

    /** RealmID's role vocabulary (ADR-101 D1). Base-realm-gated. */
    public RoleTemplatesClient roleTemplates() { return roleTemplates; }
    /** Owner/admin service-account surface (ADR-071). */
    public ServiceAccountsClient serviceAccounts() { return serviceAccounts; }
    /** Owner/admin app/source registry (ADR-072). */
    public SourcesClient sources() { return sources; }
    /** Cross-realm integrations: source register/mint + target install (ADR-082/083). */
    public IntegrationsClient integrations() { return integrations; }
    /** Workload-identity federation trust bindings (ADR-057). */
    public FederationBindingsClient federationBindings() { return federationBindings; }
    /** Owner-facing signing-key read + self-serve rotate (roles/signing-keys overhaul). */
    public SigningKeysClient signingKeys() { return signingKeys; }
    /** Identity-provider config CRUD (admin resource; distinct from IdP discovery). */
    public IdentityProviderConfigClient identityProviderConfig() { return identityProviderConfig; }
    /** Public IdP discovery (SPEC §6.10) — the login provider list for SPAs. */
    public IdentityProvidersClient identityProviders() { return identityProviders; }
    public OriginsClient origins() { return origins; }
    /** SPEC §6.7 — access-token revocation cache. */
    public TokensClient tokens() { return tokens; }

    /** The configured ADR-107 authority cache, or {@code null} when not wired. */
    public dev.realmid.sdk.authority.AuthorityCache authority() { return authority; }

    /**
     * Announces that a principal's authority changed, so tokens minted before
     * now stop being trusted to describe it (ADR-107 D7).
     *
     * <p>This is the ONE method a partner calls. The SDK owns everything after
     * it: storage, TTLs, the verifier check, the wire code, and the client-side
     * retry cap. Nothing in the issuer changes.
     *
     * <p>The change reaches tokens presented from now on; the user's next API
     * call answers {@code 401 token_stale} and their client refreshes once,
     * transparently. A user idle at the moment of the change is caught the
     * instant they do anything.
     *
     * <p><b>⚠️ Out-of-band changes are NOT covered</b> (D14). A role edited from
     * the RealmID console, the CLI, or a back-office that does not call this
     * method stays stale for up to the realm's {@code access_ttl_seconds}. That
     * is the accepted cost of a partner-local cache, and it is the number to
     * quote publicly — not the ~0 on notified paths.
     *
     * @throws RealmException when no authority cache is configured (D15 — a
     *         silent no-op there means a partner believes demotion is
     *         propagating while nothing is stored), when {@code subject} is
     *         blank, or when {@code intent} is absent.
     */
    public void notifyAuthorityChanged(dev.realmid.sdk.authority.AuthorityChange change) {
        if (authority == null) {
            throw new RealmException(ErrorCode.BAD_REQUEST,
                    "realmid: notifyAuthorityChanged called with no AuthorityCache configured — "
                            + "set Realm.builder().authority(...) (ADR-107 D15); nothing was recorded");
        }
        if (change == null || change.subject() == null || change.subject().isEmpty()) {
            throw new RealmException(ErrorCode.BAD_REQUEST,
                    "realmid: AuthorityChange.subject is required — pass the `sub` claim "
                            + "(the per-membership users-row id, ADR-107 D4)");
        }
        if (change.intent() == null) {
            throw new RealmException(ErrorCode.BAD_REQUEST,
                    "realmid: AuthorityChange.intent must be DEMOTED or PROMOTED — the SDK will "
                            + "not infer it (ADR-107 D11). To sign the principal out, use sessions().revokeUser(...).");
        }

        java.time.Duration ttl = change.accessTokenTtl();
        if (ttl == null || ttl.isZero() || ttl.isNegative()) {
            ttl = dev.realmid.sdk.authority.AuthorityChange.DEFAULT_ACCESS_TTL;
        }
        java.time.Instant now = java.time.Instant.now(clock);
        // D8: stamped EARLY, never as bare now. D6: the entry outlives every
        // token that could still carry the old authority — the access-token
        // lifetime plus the same skew allowance, so a token minted just before
        // the marker cannot outlive the marker itself.
        authority.markStale(
                change.subject(),
                now.minus(dev.realmid.sdk.authority.AuthorityChange.SKEW_ALLOWANCE),
                now.plus(ttl).plus(dev.realmid.sdk.authority.AuthorityChange.SKEW_ALLOWANCE));
    }
    /** SPEC §7.5 — admin aggregates surface (ADR-048). */
    public AdminClient admin() { return admin; }
    /** SPEC §7.6 — partner audit-event feed (ADR-055). */
    public AuditEventsClient auditEvents() { return auditEvents; }
    /** Owner/admin session-revocation surface (ADR-080): force-logout a member or the whole realm. */
    public SessionsClient sessions() { return sessions; }

    /**
     * The caller's OWN membership self-service (ADR-092 D5): settle the
     * single-tenant picker, decline an invitation, leave an org. Authorized by
     * the end user, never by the platform credential alone.
     */
    public MeClient me() { return me; }
    public ConfigClient config() { return config; }
    /** Platform KPI rollup (orgs/users/sessions-24h/MFA coverage). */
    public StatsClient stats() { return stats; }
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
        private dev.realmid.sdk.authority.AuthorityCache authority;
        private dev.realmid.sdk.auth.ProductRolesHandler productRoles;
        private dev.realmid.sdk.auth.ScopesHandler scopes;

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

        /**
         * ADR-107 — registers the SUBJECT-keyed staleness marker the verifier
         * consults after its standard claim checks. It is what makes demotion
         * and promotion expressible at all: a jti denylist can only deny a token
         * the SDK is HOLDING, and an admin demoting a colleague holds neither
         * that colleague's token nor its jti.
         *
         * <p>Optional. Unset → no-op; the verifier behaves exactly as it did
         * before ADR-107. Pass a {@link dev.realmid.sdk.authority.MemAuthorityCache}
         * for a single-process default, or a shared backend for multi-replica
         * deploys — where the in-memory default is silently wrong, since a
         * marker written on one replica is invisible to the others.
         */
        public Builder authority(dev.realmid.sdk.authority.AuthorityCache v) {
            this.authority = v;
            return this;
        }

        /**
         * ADR-102 — registers the handler that resolves the PARTNER's own role
         * names for a principal in one org, which the SDK mints onto the access
         * token as the {@code product_roles} claim.
         *
         * <p>Optional. Unset means the claim is simply omitted — see
         * {@link dev.realmid.sdk.auth.ProductRolesHandler} for the full
         * contract, including the side-effect freedom that makes the D11 retry
         * policy legal.
         */
        public Builder productRoles(dev.realmid.sdk.auth.ProductRolesHandler v) {
            this.productRoles = v;
            return this;
        }

        /**
         * ADR-097 — registers the handler that resolves the PARTNER's own scope
         * strings for a principal in one org, which the SDK mints onto the
         * access token's {@code scope} claim on EVERY mint, refresh included.
         *
         * <p>Optional. Unset means the claim is simply omitted — see
         * {@link dev.realmid.sdk.auth.ScopesHandler} for the full contract.
         *
         * <p><b>⚠️ Use THIS, not {@code TokenRequest.scope}, for anything that
         * must reach human sessions.</b> The per-call field only covers mints a
         * partner writes by hand; in a BFF deployment {@code RealmFilter}
         * builds the request itself, so the per-call field never reaches the
         * lane humans actually use.
         */
        public Builder scopes(dev.realmid.sdk.auth.ScopesHandler v) {
            this.scopes = v;
            return this;
        }

        public Realm build() { return new Realm(this); }
    }
}

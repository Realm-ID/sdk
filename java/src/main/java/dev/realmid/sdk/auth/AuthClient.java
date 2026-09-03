package dev.realmid.sdk.auth;

import com.fasterxml.jackson.databind.JsonNode;
import dev.realmid.sdk.ErrorCode;
import dev.realmid.sdk.RealmException;
import dev.realmid.sdk.scope.Scopes;
import dev.realmid.sdk.http.HttpTransport;
import dev.realmid.sdk.pagination.Page;
import dev.realmid.sdk.pagination.PageReader;
import dev.realmid.sdk.pagination.Paginated;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.function.Supplier;

/** SPEC §4. */
public final class AuthClient {

    private final HttpTransport http;
    private final String realmId;
    private final Supplier<String> originResolver;
    /**
     * ADR-102 — resolves the PARTNER's own role names for a principal in one
     * org. null means the claim is simply omitted.
     */
    private final ProductRolesHandler productRoles;
    /**
     * ADR-097 — resolves the PARTNER's own scope strings (granted authority)
     * for a principal in one org. null means the claim is simply omitted.
     */
    private final ScopesHandler scopes;

    public AuthClient(HttpTransport http, String realmId, Supplier<String> originResolver) {
        this(http, realmId, originResolver, null, null);
    }

    /** Pre-ADR-097-handler constructor; registers no scope resolver. */
    public AuthClient(HttpTransport http, String realmId, Supplier<String> originResolver,
                      ProductRolesHandler productRoles) {
        this(http, realmId, originResolver, productRoles, null);
    }

    public AuthClient(HttpTransport http, String realmId, Supplier<String> originResolver,
                      ProductRolesHandler productRoles, ScopesHandler scopes) {
        this.http = http;
        this.realmId = realmId;
        this.originResolver = originResolver;
        this.productRoles = productRoles;
        this.scopes = scopes;
    }

    /**
     * SPEC §4.1 — exchange a provider token for a realm-scoped session.
     *
     * <h2>⚠️ BREAKING (ADR-102 D10): {@code login} MINTS now</h2>
     *
     * <p>Once the tenant is settled, {@code login} follows {@code /auth/login}
     * with a {@code /auth/token} mint, and the {@link ProductRolesHandler} runs
     * there. It is a CHANGED entry point, not a new one: a separate
     * {@code loginAndMint} would have been non-breaking and would have left the
     * default wrong — every consumer who never knew to re-mint would keep the
     * role-blind token, which is the exact failure this removes.
     *
     * <p>Two branches, and they are the two {@code /auth/login} already has:
     *
     * <ul>
     *   <li><b>exactly one tenant</b> — mint immediately; the caller gets a
     *       fully-minted session in one call, as today.</li>
     *   <li><b>several tenants</b> ({@link Session#needsTenantChoice()}) — do
     *       NOT mint. Your app presents the choice, with your labels and your
     *       role names, and calls {@link #completeLogin} on selection.</li>
     * </ul>
     *
     * <p><b>⚠️ Do NOT settle the multi-tenant branch with
     * {@link Session#selectTenant(String)}.</b> Its {@code tenants[0]} fallback
     * would mint for an ARBITRARY tenant and resolve THAT tenant's roles — a
     * silent wrong answer, not an error.
     *
     * <p>What moves for you: the {@code 412 mfa_required} gate now surfaces from
     * {@code login} where it previously surfaced from your own {@code token}
     * call.
     *
     * <p>The session {@code /auth/login} created is NOT discarded when the mint
     * fails: it rides on a {@link LoginMintException}, the ADR-102 OQ8 RECOVERY
     * ANCHOR. Read that class for why it is on the exception rather than in the
     * return value.
     */
    public Session login(LoginRequest req) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("realm_id", realmId);
        // ADR-051: the issuer's loginReq reads grant_type/provider/token —
        // it never reads "provider_token" and the deprecated "method" field
        // rides a legacyMethodToGrant shim (Sunset 2026-08-01). Mirrors Go's
        // Auth.Login. The platform access token is auto-attached as the
        // Authorization bearer by HttpTransport — the two-step exchange of
        // ADR-051 §4.0: platform bearer authorizes the caller, this token
        // authenticates the user.
        body.put("grant_type", "provider_token");
        body.put("provider", req.method());
        body.put("token", req.providerToken());
        // ADR-100 D16. Null-guarded, not empty-guarded: an EMPTY supplied list is
        // a real instruction ("this role confers nothing here") that the issuer
        // answers with a 403 naming the org. Folding it into "not supplied" would
        // mint the unnarrowed cap instead — the widest reading of the narrowest
        // input.
        if (req.rolePermissions() != null) body.put("role_permissions", req.rolePermissions());
        HttpTransport.Request r = HttpTransport.Request.of("POST", "/auth/login").body(body);
        attachOrigin(r, req.origin());
        // ADR-062: the device label rides as a header on the USER grant only.
        // The platform bootstrap this call sits behind is an M2M mint that
        // records no device, so it never carries the label.
        String deviceLabel = headerSafeDeviceName(req.deviceName());
        if (!deviceLabel.isEmpty()) {
            r.header("x-device-name", deviceLabel);
        }
        JsonNode raw = http.request(r);
        Session session = http.mapper().convertValue(raw, Session.class);
        // ADR-102 D10 — mint once the tenant is settled. See the doc comment.
        String settled = settledTenant(session);
        if (settled != null && !settled.isEmpty()) {
            return mintOrThrowWithAnchor(session, settled, req.rolePermissions(), req.origin());
        }
        return session;
    }

    /**
     * Mints, and on failure throws a {@link LoginMintException} CARRYING the
     * session.
     *
     * <p><b>⚠️ Throwing a bare exception would silently drop the ADR-102 OQ8
     * recovery anchor</b>, because a caller's {@code catch} has no other handle
     * on the session — and the users stranded by that are exactly the ones
     * ADR-092's session-limit affordance and ADR-061's enrollment gate exist for.
     */
    private Session mintOrThrowWithAnchor(Session session, String tenantId,
                                          java.util.List<String> rolePermissions, String origin) {
        try {
            return mintProductRoles(session, tenantId, rolePermissions, origin);
        } catch (RuntimeException e) {
            throw new LoginMintException(session, tenantId, e);
        }
    }

    /**
     * Finishes a multi-tenant login: runs the {@link ProductRolesHandler} for
     * the CHOSEN tenant, mints through {@code /auth/token}, and returns the
     * updated session (ADR-102 D10).
     *
     * <p>A record cannot be updated in place, so this RETURNS a new session
     * where Go and TS mutate one. The contract is identical; only the idiom
     * differs.
     *
     * <p>Call it when {@link Session#needsTenantChoice()} reported true and your
     * app has presented the choice. A tenant the session does not list is
     * refused LOCALLY rather than sent: the issuer's answer for it
     * ({@code invalid_credentials}) would read as a login failure rather than
     * the caller bug it is.
     */
    public Session completeLogin(Session session, String tenantId,
                                 java.util.List<String> rolePermissions) {
        if (session == null) throw new IllegalArgumentException("completeLogin needs a session");
        if (tenantId == null || tenantId.isEmpty()) {
            throw new IllegalArgumentException(
                    "completeLogin needs a tenantId — the multi-tenant branch does not "
                            + "auto-pick, and selectTenant's tenants[0] fallback would mint "
                            + "for an arbitrary org");
        }
        boolean known = session.tenants() == null || session.tenants().isEmpty();
        if (session.tenants() != null) {
            for (Session.TenantRef t : session.tenants()) {
                if (tenantId.equals(t.id())) {
                    known = true;
                    break;
                }
            }
        }
        if (!known) {
            throw new IllegalArgumentException(
                    "tenant " + tenantId + " is not one of this session's memberships");
        }
        return mintProductRoles(session, tenantId, rolePermissions, null);
    }

    /**
     * Returns the tenant a login resolved to, or null when the caller must still
     * choose (ADR-102 D10).
     *
     * <p>"Settled" means the issuer picked one: a flat {@code tenant_id}, or
     * exactly one membership. It deliberately does NOT fall back to
     * {@code tenants[0]} on a multi-tenant login — that is what
     * {@link Session#selectTenant(String)} does for a caller who has already
     * decided, and using it here would mint for an arbitrary org and resolve
     * that org's roles.
     */
    private static String settledTenant(Session s) {
        if (s == null) return null;
        if (s.tenantId() != null && !s.tenantId().isEmpty()) return s.tenantId();
        if (s.tenants() != null && s.tenants().size() == 1) return s.tenants().get(0).id();
        return null;
    }

    /**
     * Runs the handler and re-mints the session through {@code /auth/token}.
     *
     * <p>With NO handler configured and an access token ALREADY in hand it
     * returns the session unchanged: a round trip that could only reproduce the
     * token we are holding is pure cost, and skipping it is what keeps D10 from
     * taxing every consumer who never adopts the claim.
     *
     * <p>The remaining condition — no handler, no access token — is exactly the
     * guard RealmID's own BFF hand-rolled, with a comment explaining that the
     * issuer skips its inline single-tenant mint under MFA and that the 412 gate
     * "fires on /auth/token, which login never calls". That is SDK documentation
     * living in a consumer; once {@code login} mints, the guard collapses and
     * the gate surfaces for EVERY consumer.
     */
    private Session mintProductRoles(Session session, String tenantId,
                                     java.util.List<String> rolePermissions, String origin) {
        // BOTH handlers gate the short-circuit. Consulting productRoles alone
        // would leave a scopes-only consumer silently never minting at all —
        // the mirror of the refresh bug, pointed at the other lane.
        if (productRoles == null && scopes == null
                && session.accessToken() != null && !session.accessToken().isEmpty()) {
            return session;
        }
        String userId = null;
        if (session.user() != null && session.user().get("id") != null) {
            userId = String.valueOf(session.user().get("id"));
        }
        // The handler's failure surfaces as a ProductRolesException / a
        // ScopesException and is NOT mapped into a RealmException. The session
        // stays intact so the caller can recover — see login's doc comment.
        java.util.List<String> roles = ProductRoles.resolve(productRoles, tenantId, userId);
        // ADR-097 granted authority, resolved on the SAME lanes and by the same
        // rules. A scopes handler that worked on refresh but not here would be
        // the mirror of the bug this whole seam exists to close, and would be
        // found the same way: by a partner, in production.
        java.util.List<String> grantedScopes = ScopeClaims.resolve(scopes, tenantId, userId);
        TokenResponse mint = token(new TokenRequest(
                session.refreshToken(), tenantId, null, origin, rolePermissions,
                grantedScopes, roles));
        return session.withMint(mint, tenantId);
    }

    /**
     * Re-mints a freshly-refreshed token so it carries the derived claims
     * (ADR-102 {@code product_roles}, ADR-097 {@code scope}), returning the
     * token response the caller should hand back.
     *
     * <h2>The bug this closes</h2>
     *
     * <p>{@link #mintProductRoles} ran on the LOGIN lanes only. Nothing ran on
     * refresh, and {@code RealmFilter.handleRefresh} minted with
     * {@code {refreshToken, tenantId, customClaims}} alone. So a BFF-fronted
     * session carried {@code product_roles} for one access-TTL and then lost it
     * for the rest of its life, while {@link ProductRolesHandler} promised in
     * writing that the handler "runs on EVERY mint, refresh included".
     *
     * <p>{@code scope} had the same hole with a sharper edge: the issuer NEVER
     * stores {@code scope} on a session (deliberately, so it cannot go stale),
     * so an unrequested claim is an absent one and
     * {@code Scopes.scopesFrom} reads absence as no granted authority. A
     * {@code ScopePolicy} gate therefore starts denying everything one
     * access-TTL into every session.
     *
     * <h2>Why the resolution happens AFTER the mint</h2>
     *
     * <p>A handler needs the user id, and the refresh lane does not have one: it
     * holds a refresh token, and the subject is inside the ACCESS token it does
     * not have yet. So the order is mint &rarr; read the subject &rarr; resolve
     * &rarr; re-mint. The subject is read LOCALLY (no network, no verification
     * round trip) from a token the issuer just signed and handed us.
     *
     * <p>The alternative — peeking the subject off the EXPIRING access token the
     * caller still holds — would save a round trip, but it reads a token we are
     * explicitly not verifying (its expiry is the reason we are here at all) and
     * it assumes the old token is still in hand at that point in the caller's
     * deployment. A refresh is not on a human's critical path the way a login
     * is, so the round trip is the cheaper mistake to make.
     *
     * <p><b>It is a NO-OP when neither handler is configured</b>, and that guard
     * is load bearing: it is what keeps the second round trip off every consumer
     * who never adopts either claim. The cost is opt-in with the feature.
     *
     * <p>An error from either handler REFUSES the refresh (as a
     * {@link ProductRolesException} / {@link ScopesException}) rather than
     * minting without the claim. Minting anyway would hand back a token that
     * reads as "no granted authority" to every gate — turning a transient blip
     * in the partner's store into an authorization outage our own logs record as
     * a clean 200.
     *
     * @param minted    the response the first {@code /auth/token} call returned
     * @param tenantId  the tenant the refresh was requested for
     * @return {@code minted} itself when nothing needed re-minting, else the
     *         second mint's response
     */
    public TokenResponse enrichRefreshMint(TokenResponse minted, String tenantId) {
        if (productRoles == null && scopes == null) return minted;
        if (minted == null
                || minted.refreshToken() == null || minted.refreshToken().isEmpty()) {
            // Nothing to re-mint against. A credential-bootstrapped session gets
            // no refresh token at all (ADR-089), so this is a legitimate shape
            // and not an error — there is simply no second mint to make.
            return minted;
        }
        // Prefer the tenant the issuer actually settled on over the one we asked
        // for: on a tenant switch they differ, and resolving for the requested
        // tenant while the token is minted for another is a silent wrong answer.
        String tenant = minted.tenantId() != null && !minted.tenantId().isEmpty()
                ? minted.tenantId() : tenantId;
        String userId = JwtPeek.subject(minted.accessToken());
        if (userId == null) {
            // Deliberately NOT an error. The peek is a convenience over a token
            // the issuer signed; if its shape ever changes we degrade to the old
            // behaviour (the claim is omitted) rather than breaking every
            // refresh. The regression tests assert the subject REACHES the
            // handler, so this branch cannot silently become the normal path
            // without turning them red.
            return minted;
        }

        java.util.List<String> roles = ProductRoles.resolve(productRoles, tenant, userId);
        java.util.List<String> grantedScopes = ScopeClaims.resolve(scopes, tenant, userId);
        boolean nothingToCarry = (roles == null || roles.isEmpty())
                && (grantedScopes == null || grantedScopes.isEmpty());
        if (nothingToCarry) {
            // Both empty means both claims would be omitted, so the re-mint could
            // only reproduce the token we are already holding. Skipping it also
            // keeps a handler that legitimately returns nothing from costing a
            // round trip on every refresh forever.
            return minted;
        }

        // Re-mint against the ROTATED refresh token. The first mint already
        // spent the one the caller presented; re-using it would fail as a replay.
        return token(new TokenRequest(minted.refreshToken(), tenant, null, null,
                null, grantedScopes, roles));
    }

    /** SPEC §4.2. */
    public TokenResponse token(TokenRequest req) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("realm_id", realmId);
        body.put("refresh_token", req.refreshToken());
        body.put("tenant_id", req.tenantId());
        if (req.customClaims() != null) body.put("custom_claims", req.customClaims());
        // ADR-100 D18 — supplied on refresh too, or a refreshed token comes back
        // WIDER than the one it replaces. See the note on the login body above
        // for why this is null-guarded rather than empty-guarded.
        if (req.rolePermissions() != null) body.put("role_permissions", req.rolePermissions());
        // ADR-102 D11 rule 2. Keyed on EMPTINESS, not null — the opposite of
        // rolePermissions directly above, and the difference is the whole point.
        // An empty rolePermissions is an instruction ("this role confers nothing
        // here"); an empty productRoles is not, because absent and empty must
        // mean the same thing. Every token issued before ADR-102 has no claim at
        // all, so a reader handles absence regardless, and minting [] would
        // invent a third state for them to interpret.
        if (req.productRoles() != null && !req.productRoles().isEmpty()) {
            body.put("product_roles", req.productRoles());
        }
        // ADR-097 mint half. Keyed on emptiness, not null — the inverse of
        // rolePermissions above, and for the stated reason: parseScope trims and
        // returns nil for "", so an empty scope IS an absent one. Computed
        // BEFORE the request is built, so an unsendable entry never spends (and
        // rotates away) the refresh token.
        String scopeWire = Scopes.wireValue(req.scope());
        if (scopeWire != null) body.put("scope", scopeWire);
        HttpTransport.Request r = HttpTransport.Request.of("POST", "/auth/token").body(body);
        attachOrigin(r, req.origin());
        JsonNode raw = http.request(r);
        return http.mapper().convertValue(raw, TokenResponse.class);
    }

    /**
     * SPEC §4.2.1 — build a {@link TokenManager} for a long-lived,
     * single-identity client, seeded with a refresh token the client already
     * holds (obtained out-of-band, e.g. at enrollment). The manager refreshes
     * against {@code POST /auth/token} directly on that token.
     */
    public TokenManager newTokenManager(String refreshToken) {
        return new TokenManager(this, refreshToken, null);
    }

    /** SPEC §4.2.1 — {@link #newTokenManager(String)} with options. */
    public TokenManager newTokenManager(String refreshToken, TokenManagerOptions opts) {
        return new TokenManager(this, refreshToken, opts);
    }

    /** SPEC §4.3. */
    public Session mfaVerify(MFAVerifyRequest req) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("realm_id", realmId);
        // Wire field is "mfa_challenge_token" (server MFAVerifyRequest required:
        // [mfa_challenge_token, code]). Go (sdk/go/auth.go) and TS
        // (sdk/ts/src/auth.ts) send the same key.
        body.put("mfa_challenge_token", req.challengeToken());
        body.put("code", req.code());
        body.put("method", req.method() == null ? "totp" : req.method());
        HttpTransport.Request r = HttpTransport.Request.of("POST", "/auth/mfa/verify").body(body);
        attachOrigin(r, req.origin());
        JsonNode raw = http.request(r);
        Session session = http.mapper().convertValue(raw, Session.class);
        // ADR-102 D10 — a step-up issues the token the user carries for the rest
        // of the session, so it is the LAST lane that may hand back a claim-blind
        // one. Without this, a partner who requires MFA has every human denied by
        // their own scope gate immediately after passing the second factor.
        String settled = settledTenant(session);
        if (settled != null && !settled.isEmpty()) {
            return mintOrThrowWithAnchor(session, settled, null, req.origin());
        }
        return session;
    }

    /**
     * SPEC §X.4 — partner OTP single-factor login. Wraps {@code POST
     * /auth/login} with {@code grant_type=otp} (ADR-071 §4 renamed the grant
     * value from {@code otp_internal}; direct cutover — the issuer no longer
     * accepts the old name); {@code identifier} is an E.164 phone or email the
     * server resolves to a tenant-scoped user, {@code presented} is the
     * manager-issued OTP value the user typed. Realm precondition:
     * {@code otp_login_enabled = true}. Mirrors Go's {@code Auth.OTPLogin} /
     * TS's {@code auth.otpLogin}.
     */
    public Session otpLogin(OtpLoginRequest req) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("realm_id", realmId);
        body.put("grant_type", "otp");
        body.put("identifier", req.identifier());
        body.put("presented", req.presented());
        if (req.tenantId() != null && !req.tenantId().isEmpty()) body.put("tenant_id", req.tenantId());
        HttpTransport.Request r = HttpTransport.Request.of("POST", "/auth/login").body(body);
        attachOrigin(r, req.origin());
        JsonNode raw = http.request(r);
        Session session = http.mapper().convertValue(raw, Session.class);
        // ADR-102 D10 — an OTP login is a login. This lane was uncovered until
        // the Go SDK's AST-derived lane guard found it; the defect report that
        // prompted the guard named only mfaVerify.
        String settled = settledTenant(session);
        if (settled != null && !settled.isEmpty()) {
            return mintOrThrowWithAnchor(session, settled, null, req.origin());
        }
        return session;
    }

    /**
     * ADR-104 — sign in with a native username/password credential.
     *
     * <p>Every failure collapses to {@code 401 invalid_credentials} — an unknown
     * handle, a user with no credential row, a wrong password, a stored
     * algorithm this issuer cannot verify. Reporting "this account has no
     * password set" separately would tell a prober which accounts are
     * password-enabled.
     *
     * <p><b>⚠️ {@code 403 password_must_change} is DIFFERENT and is not
     * collapsed:</b> the password was CORRECT, but an administrator set it, so
     * it is an assertion rather than a proof and the holder must replace it
     * through {@code PUT /me/password} first. Saying "invalid credentials" there
     * would send them to a reset flow that does not exist.
     *
     * <p>A {@code kind=service} account cannot hold a password: its lanes are
     * {@code api_key} and {@code otp}/{@code view_bff} (ADR-071), and a service
     * account with a human-chosen secret is a shared password by another name.
     */
    public Session passwordLogin(PasswordLoginRequest req) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("realm_id", realmId);
        body.put("grant_type", "password");
        body.put("identifier", req.identifier());
        body.put("presented", req.presented());
        if (req.tenantId() != null && !req.tenantId().isEmpty()) {
            body.put("tenant_id", req.tenantId());
        }
        HttpTransport.Request r = HttpTransport.Request.of("POST", "/auth/login").body(body);
        attachOrigin(r, req.origin());
        JsonNode raw = http.request(r);
        Session session = http.mapper().convertValue(raw, Session.class);
        // ADR-102 D10 — same mint rule as login: once the tenant is settled the
        // product-roles handler runs and the session is re-minted. A password
        // login is a login, so it must not be the one lane that returns a
        // role-blind token.
        String settled = settledTenant(session);
        if (settled != null && !settled.isEmpty()) {
            return mintOrThrowWithAnchor(session, settled, null, req.origin());
        }
        return session;
    }

    /**
     * SPEC §X.5 — partner OTP second-factor verify. Thin wrapper over
     * {@link #mfaVerify(MFAVerifyRequest)} with {@code method=otp} pre-set
     * (ADR-071 §4 renamed the value from {@code otp_internal}); the
     * {@code mfaToken} comes from a prior {@code /auth/login} response that
     * advertised {@code "otp"} in {@code methods[]}. Realm precondition:
     * {@code otp_mfa_enabled = true} and the user is enrolled in {@code otp}.
     * Mirrors Go's {@code Auth.MFAVerifyOTP} / TS's {@code auth.mfaVerifyOtp}.
     */
    public Session mfaVerifyOtp(MfaVerifyOtpRequest req) {
        return mfaVerify(new MFAVerifyRequest(req.mfaToken(), req.presented(), "otp", req.origin()));
    }

    /** SPEC §4.4. */
    public Map<String, Object> logout(LogoutRequest req) {
        if (req == null) req = LogoutRequest.empty();
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("realm_id", realmId);
        body.put("refresh_token", req.refreshToken());
        HttpTransport.Request r = HttpTransport.Request.of("POST", "/auth/logout").body(body);
        attachOrigin(r, req.origin());
        JsonNode raw = http.request(r);
        @SuppressWarnings("unchecked")
        Map<String, Object> out = http.mapper().convertValue(raw, Map.class);
        return out == null ? Map.of("status", "ok") : out;
    }

    /** SPEC §4.5. */
    public void revokeSession(String sessionId, String userBearer) {
        HttpTransport.Request r = HttpTransport.Request.of(
                "DELETE", "/auth/sessions/" + java.net.URLEncoder.encode(sessionId, java.nio.charset.StandardCharsets.UTF_8))
                .bearer(userBearer);
        http.request(r);
    }

    /** SPEC §4.6. Note: paginated wire shape per SPEC §7. */
    public Paginated<Session> listSessions(String userBearer) {
        return Paginated.of(opts -> {
            Map<String, Object> q = new LinkedHashMap<>();
            if (opts.cursor() != null) q.put("cursor", opts.cursor());
            if (opts.limit() != null) q.put("limit", opts.limit());
            HttpTransport.Request r = HttpTransport.Request.of("GET", "/auth/sessions")
                    .query(q).bearer(userBearer);
            JsonNode raw = http.request(r);
            return PageReader.read(http.mapper(), raw, Session.class);
        });
    }

    /**
     * SPEC §10.1 / §10.4 — mint an MFA challenge token from an access
     * token. The middleware uses this to issue 412 envelopes on
     * MFA-protected paths without forcing the partner app to round-trip
     * through {@link #login} again.
     *
     * The server endpoint may not exist yet. On 404/501, this throws
     * {@link RealmException} with {@link ErrorCode#SERVER_ERROR} and the
     * message "mfa challenge mint not yet supported by server" — same
     * semantics as the TS/Go SDKs.
     */
    public MfaChallengeMint mintMfaChallenge(String accessToken) {
        // Empty body — the bearer identifies user, session, and realm.
        Map<String, Object> body = new LinkedHashMap<>();
        JsonNode raw;
        try {
            raw = http.request(HttpTransport.Request.of("POST", "/auth/mfa/challenge")
                    .bearer(accessToken).body(body));
        } catch (RealmException e) {
            if (e.getHttpStatus() == 404 || e.getHttpStatus() == 501) {
                throw new RealmException(ErrorCode.SERVER_ERROR,
                        "mfa challenge mint not yet supported by server", e);
            }
            throw e;
        }
        MFAChallenge c = http.mapper().convertValue(raw, MFAChallenge.class);
        if (c == null || c.mfaChallengeToken() == null || c.mfaChallengeToken().isEmpty()) {
            throw new RealmException(ErrorCode.SERVER_ERROR,
                    "mfa challenge mint not yet supported by server");
        }
        java.util.List<String> methods = c.methods();
        if (methods == null || methods.isEmpty()) methods = java.util.List.of("totp");
        return new MfaChallengeMint(c.mfaChallengeToken(), methods);
    }

    /** Result of {@link #mintMfaChallenge(String)} (SPEC §10.4). */
    public record MfaChallengeMint(String challengeToken, java.util.List<String> methods) {}

    /**
     * Self-service MFA enroll — refresh-authed {@code POST /auth/mfa/enroll}
     * (ADR-061). The user's {@code refreshToken} authorizes enrollment, so a
     * first-login user whose access token was withheld by the MFA gate can
     * still bootstrap a factor; the same call serves a post-login user
     * switching into an MFA-required tenant. The refresh travels in the body
     * and the platform token rides as the Authorization bearer (auto-attached
     * by {@link HttpTransport}), exactly mirroring {@link #token(TokenRequest)}.
     *
     * <p>{@code method} is optional (server defaults to {@code "totp"}).
     * Returns the freshly provisioned TOTP secret, an otpauth QR URL, recovery
     * codes, and an enroll-scoped {@code mfa_challenge_token} the caller
     * completes via {@link #mfaVerify(MFAVerifyRequest)} — there is no separate
     * confirm step.
     */
    public MfaEnrollment enrollMfa(SelfEnrollMfaRequest req) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("refresh_token", req.refreshToken());
        body.put("tenant_id", req.tenantId());
        if (req.method() != null && !req.method().isEmpty()) body.put("method", req.method());
        // No explicit bearer: HttpTransport auto-attaches the platform token,
        // and the refresh rides in the body (mirrors token()).
        HttpTransport.Request r = HttpTransport.Request.of("POST", "/auth/mfa/enroll").body(body);
        attachOrigin(r, req.origin());
        JsonNode raw = http.request(r);
        return http.mapper().convertValue(raw, MfaEnrollment.class);
    }

    /**
     * Self-service MFA disable — {@code DELETE /auth/mfa} with a step-up TOTP
     * code in the body. Current-user op; dual-mode bearer. The server returns
     * {@code {"status":"disabled"}}; the SDK returns void.
     */
    public void disableMfa(DisableMfaRequest req) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", req.code());
        HttpTransport.Request r = HttpTransport.Request.of("DELETE", "/auth/mfa").body(body);
        applyBearerTrio(r, req.userId(), req.userBearer(), req.onBehalfOfIp());
        http.request(r);
    }

    /**
     * Revoke all of the current user's sessions — {@code DELETE /auth/sessions}.
     * Current-user op; dual-mode bearer; no body. The server returns
     * {@code {"status":"ok"}}; the SDK returns void. Revocation-class tokens
     * are rejected by the server with {@code insufficient_scope}, surfaced as a
     * {@link RealmException}.
     */
    public void revokeAllSessions(RevokeAllSessionsRequest req) {
        HttpTransport.Request r = HttpTransport.Request.of("DELETE", "/auth/sessions");
        applyBearerTrio(r, req.userId(), req.userBearer(), req.onBehalfOfIp());
        http.request(r);
    }

    /**
     * List the current user's enrolled MFA authenticator(s) and remaining
     * backup-code count — {@code GET /auth/mfa/authenticators} (issuer v0.50.0).
     * A read, NOT MFA-gated. Current-user op; dual-mode bearer; no body.
     */
    public AuthenticatorList listAuthenticators(ListAuthenticatorsRequest req) {
        HttpTransport.Request r = HttpTransport.Request.of("GET", "/auth/mfa/authenticators");
        applyBearerTrio(r, req.userId(), req.userBearer(), req.onBehalfOfIp());
        JsonNode raw = http.request(r);
        return http.mapper().convertValue(raw, AuthenticatorList.class);
    }

    /**
     * Mint a fresh set of recovery codes for the current user — {@code POST
     * /auth/mfa/recovery/regenerate} (issuer v0.50.0), invalidating the previous
     * set. Requires a CONFIRMED enrollment (else {@code RealmException(conflict)},
     * 409, code {@code not_enrolled}) and is gated on a FRESH TOTP within the
     * elevated window ({@code RealmException(mfa_required)}, 412, until
     * re-verified). Codes are shown once and also emailed (ADR-079). Current-user
     * op; dual-mode bearer; no body.
     */
    public RecoveryCodes regenerateRecoveryCodes(RegenerateRecoveryCodesRequest req) {
        HttpTransport.Request r = HttpTransport.Request.of("POST", "/auth/mfa/recovery/regenerate");
        applyBearerTrio(r, req.userId(), req.userBearer(), req.onBehalfOfIp());
        JsonNode raw = http.request(r);
        return http.mapper().convertValue(raw, RecoveryCodes.class);
    }

    /**
     * Resolve the dual-mode bearer trio onto a request, mirroring the model
     * used by {@link #revokeSession} / {@link #listSessions}: exactly one of
     * {@code userBearer} (legacy mode, sent as the Authorization bearer) or
     * {@code userId} (BFF mode, sent as {@code X-On-Behalf-Of-User} while the
     * transport auto-attaches the platform token). {@code onBehalfOfIp} is
     * optional and only meaningful in BFF mode.
     */
    private void applyBearerTrio(HttpTransport.Request r, String userId, String userBearer, String onBehalfOfIp) {
        boolean hasBearer = userBearer != null && !userBearer.isEmpty();
        boolean hasUserId = userId != null && !userId.isEmpty();
        if (hasBearer == hasUserId) {
            throw new RealmException(ErrorCode.BAD_REQUEST,
                    "realmid: exactly one of userBearer or userId is required");
        }
        if (hasBearer) {
            r.bearer(userBearer);
        } else {
            // Since issuer v0.66.0 a BARE X-On-Behalf-Of-User is NOT an
            // identity — it was an unauthenticated user id that any holder of a
            // realm's platform key could use to act as any user in that realm.
            // The issuer answers 401 x_user_token_required and only the
            // VERIFIED X-User-Token asserts the caller; the id survives as
            // attribution beside it.
            //
            // Refuse here rather than issuing a request that is certain to 401
            // (measured against a live issuer, 2026-08-21): the server's error
            // cannot name the SDK call site that forgot the token, and this can.
            if (!http.hasUserToken()) {
                throw new RealmException(ErrorCode.BAD_REQUEST,
                        "realmid: BFF mode needs the user's access JWT as well as userId — "
                                + "derive the client with realm.withUserToken(accessJWT); the issuer "
                                + "refuses a bare X-On-Behalf-Of-User with 401 x_user_token_required");
            }
            r.header("x-on-behalf-of-user", userId);
            if (onBehalfOfIp != null && !onBehalfOfIp.isEmpty()) {
                r.header("x-on-behalf-of-ip", onBehalfOfIp);
            }
        }
    }


    /**
     * Removes the characters an HTTP header field value cannot carry (C0
     * controls and DEL). NOT a policy check: the issuer's
     * {@code sanitizeDeviceName} strips the same class AND caps the value at
     * 120 characters — the cap stays there, because a client-side copy of a
     * server policy drifts the day either side changes.
     *
     * <p>This exists because the transport refuses such a value outright: the
     * JDK's {@code HttpRequest.Builder.header} rejects illegal characters, as
     * undici and Go's http client do, so a label containing a newline did not
     * arrive sanitized — the whole login failed with an error naming the
     * network rather than the argument. Stripping here yields exactly the value
     * the server would have stored.
     */
    static String headerSafeDeviceName(String s) {
        if (s == null) return "";
        StringBuilder b = new StringBuilder(s.length());
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c >= 0x20 && c != 0x7f) b.append(c);
        }
        return b.toString().trim();
    }

    private void attachOrigin(HttpTransport.Request r, String perCall) {
        String o = perCall != null && !perCall.isEmpty() ? perCall
                : (originResolver == null ? null : originResolver.get());
        if (o != null && !o.isEmpty()) r.header("origin", o);
    }
}

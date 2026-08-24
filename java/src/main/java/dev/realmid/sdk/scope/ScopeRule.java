package dev.realmid.sdk.scope;

import java.util.Collections;
import java.util.List;

/**
 * One entry in a {@link ScopePolicy}: ADR-097 layer 2.
 *
 * <p>The path is a glob using the same matcher as the MFA-protected paths
 * ({@code *} within a segment, {@code **} across segments), so a partner learns
 * one path syntax for this SDK rather than two.
 */
public final class ScopeRule {

    private final String path;
    private final String method;
    private final List<String> scopes;
    private final boolean anyOf;
    private final boolean isPublic;

    private ScopeRule(String path, String method, List<String> scopes, boolean anyOf, boolean isPublic) {
        this.path = path;
        this.method = method;
        this.scopes = scopes == null ? Collections.emptyList() : List.copyOf(scopes);
        this.anyOf = anyOf;
        this.isPublic = isPublic;
    }

    /**
     * A route requiring ALL of {@code scopes}, on any HTTP method.
     *
     * <p>All-of is what a bare list means, deliberately — see
     * {@link Scopes#scopeAllows}.
     */
    public static ScopeRule requireAll(String path, String... scopes) {
        return new ScopeRule(path, null, List.of(scopes), false, false);
    }

    /** A route requiring AT LEAST ONE of {@code scopes}. Has to be asked for. */
    public static ScopeRule requireAny(String path, String... scopes) {
        return new ScopeRule(path, null, List.of(scopes), true, false);
    }

    /**
     * A route needing NO scope at all.
     *
     * <p>This exists so that "unauthenticated" is something a partner SAYS,
     * never something they get by forgetting. A {@link ScopePolicy} denies by
     * default, so an unlisted route is refused rather than waved through —
     * silence must never mean open.
     */
    public static ScopeRule publicRoute(String path) {
        return new ScopeRule(path, null, List.of(), false, true);
    }

    /**
     * Narrows this rule to one HTTP method.
     *
     * <p>Omitting a method means ANY method — right for a resource whose whole
     * surface needs one scope, wrong for one where reading and writing differ,
     * so it is worth being deliberate about.
     */
    public ScopeRule onMethod(String httpMethod) {
        return new ScopeRule(path, httpMethod, scopes, anyOf, isPublic);
    }

    public String path() { return path; }
    public String method() { return method; }
    public List<String> scopes() { return scopes; }
    public boolean anyOf() { return anyOf; }
    public boolean isPublic() { return isPublic; }
}

package dev.realmid.sdk.scope;

import java.util.Collections;
import java.util.List;

/** The outcome of evaluating a {@link ScopePolicy} against one request. */
public final class ScopeDecision {

    private final boolean allowed;
    private final boolean matched;
    private final boolean isPublic;
    private final List<String> required;
    private final boolean anyOf;
    private final List<String> missing;

    ScopeDecision(boolean allowed, boolean matched, boolean isPublic,
                  List<String> required, boolean anyOf, List<String> missing) {
        this.allowed = allowed;
        this.matched = matched;
        this.isPublic = isPublic;
        this.required = required == null ? Collections.emptyList() : List.copyOf(required);
        this.anyOf = anyOf;
        this.missing = missing == null ? Collections.emptyList() : List.copyOf(missing);
    }

    static ScopeDecision denied() {
        return new ScopeDecision(false, false, false, List.of(), false, List.of());
    }

    /** The answer. Everything else explains it. */
    public boolean allowed() { return allowed; }

    /**
     * Whether ANY rule matched. False means the request was denied by the
     * default-deny rule — a configuration gap rather than an authorization
     * failure, and worth logging differently.
     */
    public boolean matched() { return matched; }

    /** The matched rule declared the route public. */
    public boolean isPublic() { return isPublic; }

    /** What the matched rule asked for. */
    public List<String> required() { return required; }

    /** Mirrors the matched rule. */
    public boolean anyOf() { return anyOf; }

    /**
     * Required scopes the token did not carry. Empty on an any-of denial, where
     * no single scope is "the" missing one.
     */
    public List<String> missing() { return missing; }
}

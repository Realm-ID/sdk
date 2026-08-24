package dev.realmid.sdk.scope;

import dev.realmid.sdk.Claims;
import dev.realmid.sdk.middleware.GlobMatcher;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * ADR-097 layer 2 — a partner's route&nbsp;-&gt;&nbsp;scope map, the thing that
 * lives in THEIR repo rather than in RealmID.
 *
 * <p><b>It DENIES BY DEFAULT.</b> A request matching no rule is refused. That is
 * the whole point: adding an endpoint and forgetting to declare its scope must
 * produce a locked door, not an open one.
 *
 * <p>Rules are evaluated IN ORDER and the FIRST match wins, so place a specific
 * rule before the general one it narrows. Order-dependence is stated rather than
 * sorted-for: "most specific wins" needs a specificity metric, and any metric
 * here would be a guess about a partner's routing.
 */
public final class ScopePolicy {

    private final List<ScopeRule> rules;

    public ScopePolicy(List<ScopeRule> rules) {
        this.rules = rules == null ? List.of() : List.copyOf(rules);
    }

    public static ScopePolicy of(ScopeRule... rules) {
        return new ScopePolicy(List.of(rules));
    }

    public List<ScopeRule> rules() { return rules; }

    /**
     * Reports configuration errors a partner should learn about at STARTUP
     * rather than by watching requests fail.
     *
     * <p>Returns EVERY problem, not the first: a partner fixing a route map
     * wants the whole list, and a validator that stops at the first error turns
     * one deploy into five.
     */
    public List<String> validate() {
        List<String> errs = new ArrayList<>();
        for (int i = 0; i < rules.size(); i++) {
            ScopeRule r = rules.get(i);
            String where = "scope rule " + i + " (" + r.path() + "): ";
            if (r.path() == null || r.path().isEmpty()) {
                errs.add("scope rule " + i + ": rule has an empty path");
            } else if (r.isPublic() && !r.scopes().isEmpty()) {
                errs.add(where + "rule is public but also lists scopes; a public route requires none");
            } else if (!r.isPublic() && r.scopes().isEmpty()) {
                // A rule requiring nothing and not marked public would deny every
                // request (scopeAllows refuses an empty requirement) — a working
                // gate for the wrong reason, and impossible to debug.
                errs.add(where + "rule lists no scopes and is not public; mark it public or give it a scope");
            }
            for (String s : r.scopes()) {
                if (!Scopes.isRfc6749ScopeToken(s)) {
                    errs.add(where + "scope \"" + s + "\" is not an RFC 6749 §3.3 scope-token; "
                            + "RealmID would refuse to mint it, so this rule could never be satisfied");
                }
            }
        }
        return errs;
    }

    /** Evaluates the policy for one request. Default DENY. */
    public ScopeDecision decide(Claims claims, String method, String path) {
        String m = method == null ? "GET" : method.toUpperCase();
        for (ScopeRule r : rules) {
            if (r.path() == null || r.path().isEmpty()) continue;
            if (r.method() != null && !r.method().toUpperCase().equals(m)) continue;
            if (!GlobMatcher.match(r.path(), path)) continue;

            if (r.isPublic()) {
                return new ScopeDecision(true, true, true, r.scopes(), r.anyOf(), List.of());
            }
            if (r.anyOf()) {
                return new ScopeDecision(Scopes.scopeAllowsAny(claims, r.scopes()),
                        true, false, r.scopes(), true, List.of());
            }
            boolean allowed = Scopes.scopeAllows(claims, r.scopes());
            List<String> missing = List.of();
            if (!allowed) {
                Set<String> held = new LinkedHashSet<>(Scopes.scopesFrom(claims));
                List<String> gaps = new ArrayList<>();
                for (String s : r.scopes()) {
                    if (!held.contains(s)) gaps.add(s);
                }
                missing = gaps;
            }
            return new ScopeDecision(allowed, true, false, r.scopes(), false, missing);
        }
        return ScopeDecision.denied();
    }
}

package dev.realmid.sdk.scope;

import dev.realmid.sdk.Claims;
import dev.realmid.sdk.middleware.RealmFilter;

import jakarta.servlet.Filter;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.ServletRequest;
import jakarta.servlet.ServletResponse;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

import java.io.IOException;
import java.util.function.BiConsumer;

/**
 * ADR-097 layer 3 — the servlet adapter.
 *
 * <p>Mount it AFTER {@link RealmFilter}, which is what verifies the token and
 * puts the claims on the request as {@link RealmFilter#CLAIMS_ATTR}. Mounted
 * before it, there are no claims and — correctly, and unhelpfully — every
 * request is denied.
 *
 * <h2>Why a servlet Filter and not a Spring component</h2>
 *
 * <p>This SDK's only compile-time web dependency is {@code jakarta.servlet-api},
 * declared {@code compileOnly}. Spring MVC and Spring Boot both run on servlets,
 * so a Filter works there with no new dependency in anybody's tree — whereas a
 * Spring-native {@code HandlerInterceptor} would put Spring into the dependency
 * graph of every partner using this SDK, including the ones who do not use it.
 * Registering it in Boot is a one-line {@code FilterRegistrationBean}.
 *
 * <p>The response is 403 with RFC 6750 §3.1's {@code insufficient_scope}. It
 * deliberately does NOT list the missing scopes: telling an unauthorized caller
 * the names of the permissions they lack is a map of the API's authority model,
 * handed out for free. The names reach the SERVER through the denial hook.
 */
public class ScopeFilter implements Filter {

    private static final String FORBIDDEN_BODY =
            "{\"error\":{\"code\":\"insufficient_scope\","
                    + "\"message\":\"this token does not carry the scope required for this route\"}}";

    private final ScopePolicy policy;
    private final BiConsumer<HttpServletRequest, ScopeDecision> onDenied;

    public ScopeFilter(ScopePolicy policy) {
        this(policy, null);
    }

    /**
     * @param onDenied called with the full decision before the 403 is written.
     *                 This is where the missing scope names go. A denial whose
     *                 {@link ScopeDecision#matched()} is false is a ROUTE THE
     *                 PARTNER NEVER DECLARED, not an unauthorized caller, and is
     *                 worth alerting on differently — the first is a deploy bug,
     *                 the second is ordinary traffic.
     */
    public ScopeFilter(ScopePolicy policy, BiConsumer<HttpServletRequest, ScopeDecision> onDenied) {
        this.policy = policy;
        this.onDenied = onDenied;
    }

    @Override
    public void doFilter(ServletRequest req, ServletResponse res, FilterChain chain)
            throws IOException, ServletException {
        if (!(req instanceof HttpServletRequest hreq) || !(res instanceof HttpServletResponse hres)) {
            chain.doFilter(req, res);
            return;
        }
        Object raw = hreq.getAttribute(RealmFilter.CLAIMS_ATTR);
        Claims claims = raw instanceof Claims c ? c : null;

        ScopeDecision d = policy == null
                // A null policy denies. An SDK treating "no policy" as "allow
                // everything" would make a wiring mistake indistinguishable from
                // a deliberately open service.
                ? ScopeDecision.denied()
                : policy.decide(claims, hreq.getMethod(), hreq.getRequestURI());

        if (d.allowed()) {
            chain.doFilter(req, res);
            return;
        }
        if (onDenied != null) {
            onDenied.accept(hreq, d);
        }
        hres.setStatus(403);
        hres.setContentType("application/json");
        hres.getWriter().write(FORBIDDEN_BODY);
    }
}

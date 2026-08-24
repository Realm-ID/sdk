package realmid

import (
	"net/http"
	"regexp"
	"strings"
)

// ---- ADR-097: SDK-enforced route authorization ----
//
// A partner adding an endpoint to their own product must not have to update
// configuration inside RealmID. RealmID stores identity and attestation; the
// PARTNER'S REPO owns the route -> scope and role -> scope maps; this file is
// the gate that evaluates one against the other.
//
// The `scope` claim (RFC 9068 §2.2.3, by reference to RFC 8693 §4.2, in RFC
// 6749 §3.3 format) is a space-delimited string of the partner's OWN scope
// strings. RealmID never parses, validates or stores them — but it DOES
// intersect them with any user-API-key `permissions_cap` at mint, so the token
// carries ONE effective set. Nothing here has to intersect anything.
//
// # Three layers, on purpose
//
//	1. ScopeAllows / ScopeAllowsAny — a pure predicate over one claim. No I/O.
//	2. ScopePolicy                  — route -> required scopes, default DENY.
//	3. ScopePolicy.Middleware       — net/http, a thin shell over layer 2.
//
// Layer 3 is a handful of lines BECAUSE layer 1 is a predicate over a single
// claim with no I/O. That is the payoff of RealmID doing the intersection: had
// the issuer emitted both operands, every adapter would carry policy.
//
// # Token scope vs CapAllows — which to use
//
// Both are correct; they trade different things, and mixing them without
// deciding gets the worst of both.
//
//	token scope: no per-request I/O; revocation lag == the realm's
//	             access_ttl_seconds (per-realm, 1..86400).
//	CapAllows:   one live read per check; ZERO revocation lag.
//
// Use token scope by DEFAULT. Use CapAllows for operations where a stale grant
// is unacceptable — money movement, permission administration, data export.
// CapAllows is not deprecated and is not going away.

// ScopesFrom returns the scopes carried by a verified token, in the order the
// issuer wrote them.
//
// Returns nil for a token with no `scope` claim — which every caller here
// treats as "no granted authority", the fail-closed reading. That is also the
// correct reading of a token minted before ADR-097, and of one whose caller
// simply asked for nothing.
func ScopesFrom(claims *Claims) []string {
	if claims == nil {
		return nil
	}
	raw, _ := claims.Extra["scope"].(string)
	if raw == "" {
		return nil
	}
	return strings.Fields(raw)
}

// ScopeAllows reports whether the token carries EVERY required scope (all-of).
//
// All-of is the default because it is the safe reading of silence: a partner
// writing `[]string{"orders:read", "orders:write"}` and getting any-of would be
// granted on half the evidence they asked for, and nothing would tell them.
// ScopeAllowsAny exists for the cases where any-of is meant, and has to be
// named.
//
// Fails CLOSED. Returns false when:
//   - claims is nil;
//   - the token carries no `scope` claim, or a malformed one;
//   - ANY required scope is absent.
//
// Calling it with NO required scopes returns false, not true. "Required nothing"
// is almost always a route someone forgot to configure, and vacuous-true on an
// empty policy is how a gate silently stops gating. A genuinely public route is
// declared as such — see ScopeRule.Public.
//
// Comparison is EXACT and CASE-SENSITIVE. No wildcards, no prefixes, no
// hierarchy — the same rule CapAllows states, for the same reason: RealmID does
// not interpret a partner's vocabulary, and neither does this. `read` does not
// imply `read:orders`, and `Read` is not `read`.
func ScopeAllows(claims *Claims, required ...string) bool {
	if len(required) == 0 {
		return false
	}
	held := scopeSet(claims)
	if held == nil {
		return false
	}
	for _, r := range required {
		if _, ok := held[r]; !ok {
			return false
		}
	}
	return true
}

// ScopeAllowsAny reports whether the token carries AT LEAST ONE of the required
// scopes. Same exact, case-sensitive matching and the same fail-closed rules as
// ScopeAllows, including the empty-required case.
func ScopeAllowsAny(claims *Claims, required ...string) bool {
	if len(required) == 0 {
		return false
	}
	held := scopeSet(claims)
	if held == nil {
		return false
	}
	for _, r := range required {
		if _, ok := held[r]; ok {
			return true
		}
	}
	return false
}

func scopeSet(claims *Claims) map[string]struct{} {
	scopes := ScopesFrom(claims)
	if len(scopes) == 0 {
		return nil
	}
	out := make(map[string]struct{}, len(scopes))
	for _, s := range scopes {
		out[s] = struct{}{}
	}
	return out
}

// ---- Layer 2: the route map ----

// ScopeRule maps one route pattern to the scopes it requires.
//
// Path is a glob using the same matcher as MiddlewareOptions.MFAProtectedPaths
// (`*` within a segment, `**` across segments), so a partner learns one
// path-matching syntax for this SDK rather than two.
//
// Method restricts the rule to one HTTP method. Empty means any method — which
// is the right default for a resource whose whole surface needs one scope, and
// the wrong one for a resource where reading and writing differ, so it is worth
// being deliberate about.
type ScopeRule struct {
	Path   string
	Method string

	// Scopes is what this route requires. ALL of them by default; see AnyOf.
	Scopes []string

	// AnyOf switches this rule to "at least one of Scopes". Off by default,
	// because all-of is the safe reading of a list (see ScopeAllows).
	AnyOf bool

	// Public marks a route as needing NO scope at all.
	//
	// This exists so that "unauthenticated" is something a partner SAYS, never
	// something they get by forgetting. A ScopePolicy denies by default, so an
	// unlisted route is refused rather than waved through — silence must never
	// mean open. Public with a non-empty Scopes is a configuration error and is
	// reported by Validate.
	Public bool
}

// ScopePolicy is a partner's route -> scope map: layer 2 of ADR-097's SDK
// surface, and the thing that lives in THEIR repo rather than in RealmID.
//
// It DENIES BY DEFAULT. A request matching no rule is refused. That is the
// whole point: adding an endpoint and forgetting to declare its scope must
// produce a locked door, not an open one.
//
// Rules are evaluated in order and the FIRST match wins, so a specific rule is
// placed before the general one it narrows. Order-dependence is stated rather
// than sorted-for, because "most specific wins" needs a specificity metric and
// any metric here would be a guess about a partner's routing.
type ScopePolicy struct {
	Rules []ScopeRule
}

// ScopeDecision is the outcome of evaluating a policy against one request.
type ScopeDecision struct {
	// Allowed is the answer. Everything else explains it.
	Allowed bool
	// Matched reports whether ANY rule matched. False means the request was
	// denied by the default-deny rule, which is a configuration gap rather than
	// an authorization failure — a distinction worth logging differently.
	Matched bool
	// Public reports that the matched rule declared the route public.
	Public bool
	// Required is what the matched rule asked for.
	Required []string
	// AnyOf mirrors the matched rule.
	AnyOf bool
	// Missing lists required scopes the token did not carry. Empty on an
	// AnyOf denial, where no single scope is "the" missing one.
	Missing []string
}

type compiledScopeRule struct {
	re     *regexp.Regexp
	method string
	rule   ScopeRule
}

// CompiledScopePolicy is a ScopePolicy with its globs compiled. Build one at
// startup with Compile and reuse it; compiling per request would put a regexp
// compilation on every hop of a hot path.
type CompiledScopePolicy struct {
	rules []compiledScopeRule
}

// Validate reports configuration errors a partner should learn about at
// startup rather than by watching requests fail.
//
// It returns EVERY problem, not the first: a partner fixing a route map wants
// the whole list, and a validator that stops at the first error turns one
// deploy into five.
func (p ScopePolicy) Validate() []error {
	var errs []error
	for i, r := range p.Rules {
		switch {
		case r.Path == "":
			errs = append(errs, &ScopeConfigError{Index: i, Msg: "rule has an empty Path"})
		case r.Public && len(r.Scopes) > 0:
			errs = append(errs, &ScopeConfigError{Index: i, Path: r.Path,
				Msg: "rule is Public but also lists Scopes; a public route requires none"})
		case !r.Public && len(r.Scopes) == 0:
			// A rule that requires nothing and is not marked Public would deny
			// every request (ScopeAllows refuses an empty requirement), which is
			// a working gate for the wrong reason and impossible to debug.
			errs = append(errs, &ScopeConfigError{Index: i, Path: r.Path,
				Msg: "rule lists no Scopes and is not Public; mark it Public or give it a scope"})
		}
		for _, s := range r.Scopes {
			if !isRFC6749ScopeToken(s) {
				errs = append(errs, &ScopeConfigError{Index: i, Path: r.Path,
					Msg: "scope " + quoteScope(s) + " is not an RFC 6749 §3.3 scope-token; " +
						"RealmID would refuse to mint it, so this rule could never be satisfied"})
			}
		}
	}
	return errs
}

// ScopeConfigError is one problem found by ScopePolicy.Validate.
type ScopeConfigError struct {
	Index int
	Path  string
	Msg   string
}

func (e *ScopeConfigError) Error() string {
	if e.Path == "" {
		return "realmid: scope rule " + itoa(e.Index) + ": " + e.Msg
	}
	return "realmid: scope rule " + itoa(e.Index) + " (" + e.Path + "): " + e.Msg
}

// Compile prepares a policy for use. It does NOT validate — call Validate
// separately and decide what to do about the result, because refusing to boot
// on a bad route map is a choice only the partner can make.
func (p ScopePolicy) Compile() *CompiledScopePolicy {
	out := &CompiledScopePolicy{rules: make([]compiledScopeRule, 0, len(p.Rules))}
	for _, r := range p.Rules {
		if r.Path == "" {
			continue
		}
		out.rules = append(out.rules, compiledScopeRule{
			re:     globToRegex(r.Path),
			method: strings.ToUpper(strings.TrimSpace(r.Method)),
			rule:   r,
		})
	}
	return out
}

// Decide evaluates the policy for one request. Default DENY.
func (c *CompiledScopePolicy) Decide(claims *Claims, method, path string) ScopeDecision {
	if c == nil {
		// A nil policy denies. An SDK that treated "no policy" as "allow
		// everything" would make a wiring mistake indistinguishable from a
		// deliberately open service.
		return ScopeDecision{}
	}
	method = strings.ToUpper(method)
	for i := range c.rules {
		cr := &c.rules[i]
		if cr.method != "" && cr.method != method {
			continue
		}
		if !cr.re.MatchString(path) {
			continue
		}
		d := ScopeDecision{
			Matched:  true,
			Public:   cr.rule.Public,
			Required: cr.rule.Scopes,
			AnyOf:    cr.rule.AnyOf,
		}
		if cr.rule.Public {
			d.Allowed = true
			return d
		}
		if cr.rule.AnyOf {
			d.Allowed = ScopeAllowsAny(claims, cr.rule.Scopes...)
			return d
		}
		d.Allowed = ScopeAllows(claims, cr.rule.Scopes...)
		if !d.Allowed {
			held := scopeSet(claims)
			for _, s := range cr.rule.Scopes {
				if _, ok := held[s]; !ok {
					d.Missing = append(d.Missing, s)
				}
			}
		}
		return d
	}
	return ScopeDecision{}
}

// ---- Layer 3: the net/http adapter ----

// ScopeMiddleware enforces the policy on every request, reading the verified
// Claims the SDK middleware placed on the context (ClaimsFrom).
//
// It must be mounted INSIDE Realm.Middleware, which is what verifies the token
// and puts the claims there. Mounted outside, ClaimsFrom returns nothing and —
// correctly, and unhelpfully — every request is denied.
//
// The response is 403 with a JSON body carrying `insufficient_scope`, matching
// RFC 6750 §3.1's error code for exactly this condition. It deliberately does
// NOT list the scopes the caller was missing: telling an unauthorized caller
// the names of the permissions they lack is a map of the API's authority model,
// handed out for free. The names are available to the SERVER through
// OnScopeDenied.
//
// # Other frameworks
//
// This SDK takes ZERO external dependencies, deliberately, so there is no
// Gin/Echo/Fiber adapter here — importing any of them would put that framework
// in every partner's dependency tree. Layer 2 is the adapter surface: three
// lines in any framework.
//
//	// Gin
//	r.Use(func(c *gin.Context) {
//	    cl, _ := realmid.ClaimsFrom(c.Request.Context())
//	    if !policy.Decide(cl, c.Request.Method, c.Request.URL.Path).Allowed {
//	        c.AbortWithStatus(http.StatusForbidden)
//	        return
//	    }
//	    c.Next()
//	})
func (c *CompiledScopePolicy) Middleware(opts ScopeMiddlewareOptions) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			claims, _ := ClaimsFrom(req.Context())
			d := c.Decide(claims, req.Method, req.URL.Path)
			if d.Allowed {
				next.ServeHTTP(w, req)
				return
			}
			if opts.OnScopeDenied != nil {
				opts.OnScopeDenied(req, d)
			}
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte(`{"error":{"code":"insufficient_scope","message":"this token does not carry the scope required for this route"}}`))
		})
	}
}

// ScopeMiddlewareOptions configures the net/http adapter.
type ScopeMiddlewareOptions struct {
	// OnScopeDenied is called with the full decision before the 403 is written.
	//
	// This is where the missing scope names go. A denial caused by
	// Matched == false is a ROUTE THE PARTNER NEVER DECLARED, not an
	// unauthorized caller, and it is worth alerting on differently — the first
	// is a deploy bug, the second is ordinary traffic.
	OnScopeDenied func(req *http.Request, d ScopeDecision)
}

// isRFC6749ScopeToken reports whether s is a valid scope-token:
//
//	1*( %x21 / %x23-5B / %x5D-7E )
//
// printable ASCII minus SPACE, DQUOTE and BACKSLASH. Used by Validate so a
// partner learns at startup that RealmID would refuse to mint a scope they have
// written into their route map — which would otherwise present as a route that
// can never be satisfied by any token.
func isRFC6749ScopeToken(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c == 0x21:
		case c >= 0x23 && c <= 0x5B:
		case c >= 0x5D && c <= 0x7E:
		default:
			return false
		}
	}
	return true
}

func quoteScope(s string) string { return `"` + s + `"` }


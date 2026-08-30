package realmid

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"time"
)

// Operation step-up MFA — the POLICY MODEL (SPEC §10.4, ADR-096).
//
// ADR-096 D2: the route→policy map lives in the ENFORCING backend, never in
// RealmID. The issuer supplies two things — the `mfa_at` claim on every access
// token, and the /auth/mfa/challenge → /auth/mfa/verify pair that refreshes it.
// Deciding which of YOUR operations demand a fresh proof is yours. So what
// ships here is the model and the matcher; the list stays your data, the same
// way ADR-101's RoleScopes map does.

// MFARule is one entry in MiddlewareOptions.MFAProtectedPaths — one
// protected-operation policy.
//
// Freshness (SPEC §10.4):
//   - MaxAge — accept any token whose mfa_at claim is at most that old.
//     Zero means "use the realm-default freshness window"
//     (MiddlewareOptions.MFADefaultMaxAge). Negative is treated as zero.
//   - RequireFresh — require mfa_at within MFARequireFreshWindow. Use for
//     irreversible operations. Strict: a legacy amr/acr-only token (no mfa_at)
//     cannot satisfy this — the gate has no way to prove freshness.
//     Setting both RequireFresh and MaxAge is a configuration error
//     (ValidateMFARules), because RequireFresh already fixes the window and the
//     pair reads as a policy that is not enforced as written.
//
// Matching:
//   - Path is matched against the request path. `{placeholder}` segments each
//     match exactly ONE non-empty segment — so a pattern copied out of
//     swagger.yaml means here what it means there — and the `*` / `**` globs
//     the middleware has always accepted still work. A query string is ignored.
//   - Method, when set, narrows to that HTTP method (compared
//     case-insensitively). Empty matches any method.
//   - WhenJSONField / WhenJSONValues narrow to requests whose JSON body sets a
//     named field to one of the listed values. See below.
//
// The FIRST matching rule wins, so put narrow rules before broad ones.
type MFARule struct {
	Path         string
	Method       string
	MaxAge       time.Duration
	RequireFresh bool

	// WhenJSONField / WhenJSONValues narrow a policy to requests whose JSON
	// body sets a named field to one of the listed values.
	//
	// This exists for one recurring shape: an endpoint that is two operations.
	// `PATCH /tenants/{id}` is both "rename an org" and "deactivate an org",
	// and only the second is irreversible. Gating both would train people to
	// click through the prompt, which is how a step-up stops being a control.
	//
	// Absent (empty field name) means the policy applies to every request that
	// matches method + path. An UNREADABLE body does NOT match: a conditioned
	// policy narrows a broader route, so a non-match means the request is
	// treated as the un-gated variant, and the issuer will reject an
	// unparseable body anyway. A condition used to WIDEN a gate would need the
	// opposite default — do not repurpose these fields for that.
	//
	// Declaring one makes the middleware buffer the request body (bounded by
	// mfaBodyLimit) so the wrapped handler still sees it. Partners who declare
	// none pay nothing.
	WhenJSONField  string
	WhenJSONValues []string
}

// MFARequireFreshWindow is the window a RequireFresh rule allows. It is not
// zero: the client needs time to complete /auth/mfa/verify and re-send the
// original request. Matches the issuer's own freshRequireMaxAge (SPEC §10.4).
const MFARequireFreshWindow = 30 * time.Second

// requireFreshWindow is the internal spelling the gate evaluator uses.
const requireFreshWindow = MFARequireFreshWindow

// mfaBodyLimit bounds the request body the middleware buffers for JSON
// narrowing. A step-up policy keys off a short discriminator field; anything
// larger than this is not a policy input, and reading it into memory on every
// request to a protected route would be a denial-of-service surface the gate
// creates rather than closes.
const mfaBodyLimit = 1 << 20 // 1 MiB

// EffectiveMaxAge resolves the freshness window this rule enforces, given the
// realm-wide default (MiddlewareOptions.MFADefaultMaxAge).
func (r MFARule) EffectiveMaxAge(defaultMaxAge time.Duration) time.Duration {
	if r.RequireFresh {
		return MFARequireFreshWindow
	}
	if r.MaxAge > 0 {
		return r.MaxAge
	}
	return defaultMaxAge
}

// ValidateMFARules reports the first authoring error in a rule set. Call it at
// startup and refuse to boot on an error, the way the BFF does — every case it
// catches is a rule that silently protects NOTHING, and a gate that is not
// enforced looks exactly like a gate that is:
//
//   - An empty Path. compileMFARules skips such a rule, so a slip in the config
//     removes protection with no signal at all.
//   - RequireFresh together with MaxAge. RequireFresh already fixes the window,
//     so the MaxAge is dead config and the rule does not do what it reads as.
//   - WhenJSONField with no WhenJSONValues — a condition that matches nothing,
//     so the rule can never fire.
//   - WhenJSONValues with no WhenJSONField — values against no field.
//
// The error names the rule's INDEX, method and path, so a partner fixes it in
// one attempt instead of bisecting the list.
func ValidateMFARules(rules []MFARule) error {
	for i, r := range rules {
		where := fmt.Sprintf("rule %d (%s %s)", i, r.Method, r.Path)
		switch {
		case r.Path == "":
			return fmt.Errorf("realmid: MFA rule %d has an empty path; it would be silently skipped", i)
		case r.RequireFresh && r.MaxAge > 0:
			return fmt.Errorf("realmid: MFA %s sets both RequireFresh and MaxAge; "+
				"RequireFresh already fixes the window and the pair reads as a policy that is not enforced", where)
		case r.WhenJSONField != "" && len(r.WhenJSONValues) == 0:
			return fmt.Errorf("realmid: MFA %s names WhenJSONField %q with no values, "+
				"which matches nothing — a rule that can never fire reads as protection and is none",
				where, r.WhenJSONField)
		case r.WhenJSONField == "" && len(r.WhenJSONValues) > 0:
			return fmt.Errorf("realmid: MFA %s lists WhenJSONValues with no WhenJSONField", where)
		}
	}
	return nil
}

// compiledMFARule is an MFARule paired with its compiled path matcher.
type compiledMFARule struct {
	re           *regexp.Regexp
	method       string
	maxAge       time.Duration
	requireFresh bool
	jsonField    string
	jsonValues   []string
}

func compileMFARules(rules []MFARule) []compiledMFARule {
	out := make([]compiledMFARule, 0, len(rules))
	for _, r := range rules {
		if r.Path == "" {
			continue
		}
		out = append(out, compiledMFARule{
			re:           mfaPathToRegex(r.Path),
			method:       r.Method,
			maxAge:       r.MaxAge,
			requireFresh: r.RequireFresh,
			jsonField:    r.WhenJSONField,
			jsonValues:   r.WhenJSONValues,
		})
	}
	return out
}

// mfaPathToRegex compiles a rule path. `{placeholder}` segments become
// "exactly one non-empty segment" — the issuer router's rule, so a pattern
// lifted from swagger.yaml matches the same requests here — and everything else
// is handed to the middleware's existing glob compiler.
func mfaPathToRegex(pat string) *regexp.Regexp {
	if !strings.ContainsRune(pat, '{') {
		return globToRegex(pat)
	}
	var sb strings.Builder
	sb.WriteString("^")
	for i := 0; i < len(pat); {
		if pat[i] == '{' {
			if end := strings.IndexByte(pat[i:], '}'); end > 0 {
				sb.WriteString("[^/]+")
				i += end + 1
				continue
			}
		}
		// Reuse the glob compiler one character at a time so `*` / `**` keep
		// their meaning and regex metacharacters stay escaped.
		sb.WriteString(strings.TrimSuffix(strings.TrimPrefix(globToRegex(pat[i:i+1]).String(), "^"), "$"))
		i++
	}
	sb.WriteString("$")
	re, err := regexp.Compile(sb.String())
	if err != nil {
		return globToRegex(pat)
	}
	return re
}

// mfaRulesNeedBody reports whether any compiled rule declares a JSON condition.
// When none does, the middleware never touches the request body.
func mfaRulesNeedBody(rules []compiledMFARule) bool {
	for i := range rules {
		if rules[i].jsonField != "" {
			return true
		}
	}
	return false
}

// findMFARule returns the first rule matching (method, path, body). body may be
// nil; it is consulted only by a rule carrying a JSON condition.
func findMFARule(rules []compiledMFARule, method, path string, body []byte) *compiledMFARule {
	if i := strings.IndexByte(path, '?'); i >= 0 {
		path = path[:i]
	}
	for i := range rules {
		r := &rules[i]
		if r.method != "" && !strings.EqualFold(r.method, method) {
			continue
		}
		if !r.re.MatchString(path) {
			continue
		}
		if r.jsonField != "" && !jsonBodyFieldMatches(body, r.jsonField, r.jsonValues) {
			continue
		}
		return r
	}
	return nil
}

// jsonBodyFieldMatches reports whether body is a JSON object whose `field` is a
// string in `values`. See the WhenJSONField doc for why an unreadable body
// deliberately does NOT match.
func jsonBodyFieldMatches(body []byte, field string, values []string) bool {
	if len(body) == 0 {
		return false
	}
	var obj map[string]any
	if err := json.Unmarshal(body, &obj); err != nil {
		return false
	}
	got, ok := obj[field].(string)
	if !ok {
		return false
	}
	for _, v := range values {
		if got == v {
			return true
		}
	}
	return false
}

package realmid

import (
	"net/http"
	"strings"
	"testing"
)

// writes covers every Set-Cookie site: the refresh cookie, the host-only and
// migrate-from deletions, and the logout clearing cookie.
func secureWrites() map[string]func(http.ResponseWriter, *MiddlewareOptions) {
	return map[string]func(http.ResponseWriter, *MiddlewareOptions){
		"set":   func(w http.ResponseWriter, o *MiddlewareOptions) { setRefreshCookie(w, o, "v") },
		"clear": func(w http.ResponseWriter, o *MiddlewareOptions) { clearRefreshCookie(w, o) },
	}
}

func hasSecure(c string) bool {
	for _, p := range strings.Split(c, ";") {
		if strings.EqualFold(strings.TrimSpace(p), "Secure") {
			return true
		}
	}
	return false
}

func TestCookieSecure_ZeroValueOptionsEverySetCookieIsSecure(t *testing.T) {
	opts := MiddlewareOptions{CookieDomain: "example.com", CookieDomainMigrateFrom: []string{"old.example.com"}}
	for name, w := range secureWrites() {
		got := setCookiesFor(opts, w)
		if len(got) < 3 {
			t.Fatalf("%s: expected at least 3 Set-Cookie headers, got %d", name, len(got))
		}
		for _, c := range got {
			if !hasSecure(c) {
				t.Errorf("%s: Set-Cookie lacks Secure: %q", name, c)
			}
		}
	}
}

func TestCookieSecure_DeprecatedFieldHasNoEffect(t *testing.T) {
	opts := MiddlewareOptions{CookieSecure: false}
	for name, w := range secureWrites() {
		for _, c := range setCookiesFor(opts, w) {
			if !hasSecure(c) {
				t.Errorf("%s: CookieSecure=false must not drop Secure: %q", name, c)
			}
		}
	}
}

func TestCookieSecure_CookieInsecureDropsSecureOnEverySite(t *testing.T) {
	opts := MiddlewareOptions{CookieInsecure: true, CookieDomain: "example.com", CookieDomainMigrateFrom: []string{"old.example.com"}}
	for name, w := range secureWrites() {
		got := setCookiesFor(opts, w)
		if len(got) < 3 {
			t.Fatalf("%s: expected at least 3 Set-Cookie headers, got %d", name, len(got))
		}
		for _, c := range got {
			if hasSecure(c) {
				t.Errorf("%s: CookieInsecure must omit Secure: %q", name, c)
			}
		}
	}
}

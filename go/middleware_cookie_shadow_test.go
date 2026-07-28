package realmid

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Cookie shadowing (Traide incident, 2026-07-28).
//
// Setting or changing MiddlewareOptions.CookieDomain on a deployment with live
// sessions leaves every browser holding TWO cookies named `realmid_refresh` at
// different scopes — RFC 6265 makes a Domain-scoped Set-Cookie unable to
// overwrite a host-only entry of the same name. Rotation then updates one and
// freezes the other, `(*http.Request).Cookie` returns the FIRST match (which
// RFC 6265 §5.4 orders as the OLDER one at equal path length), and the
// middleware reads the stale token on every refresh, forever. Logout did not
// help, because it too only cleared the configured scope.
//
// Two halves, tested separately because they fix different things: reading
// every candidate RESTORES service for an already-stranded browser, and
// evicting the other scopes is what actually CLEANS UP.

// ---- read every candidate ----

func TestReadRefreshTokens_ReturnsEveryCandidateInOrder(t *testing.T) {
	opts := &MiddlewareOptions{}
	opts.applyDefaults()

	req := httptest.NewRequest("POST", "/auth/token", nil)
	// The captured production request: stale (host-only, older) first.
	req.Header.Add("Cookie", "_tccl_visitor=x; realmid_refresh=stale; realmid_refresh=live")

	got := readRefreshTokens(req, opts)
	if len(got) != 2 || got[0] != "stale" || got[1] != "live" {
		t.Fatalf("want both candidates in header order, got %v", got)
	}
	// The old single-value read is what picked the wrong one.
	if first := readRefreshToken(req, opts); first != "stale" {
		t.Fatalf("readRefreshToken must stay first-match (public API), got %q", first)
	}
}

func TestReadRefreshTokens_DedupesAndCaps(t *testing.T) {
	opts := &MiddlewareOptions{}
	opts.applyDefaults()

	req := httptest.NewRequest("POST", "/auth/token", nil)
	req.Header.Add("Cookie", "realmid_refresh=a; realmid_refresh=a; realmid_refresh=b; realmid_refresh=c; realmid_refresh=d")

	got := readRefreshTokens(req, opts)
	// Dedup drops the repeat; the cap stops an inflated jar from being turned
	// into N issuer calls per request.
	if len(got) != maxRefreshCandidates {
		t.Fatalf("want %d candidates after dedup+cap, got %d (%v)", maxRefreshCandidates, len(got), got)
	}
	if got[0] != "a" || got[1] != "b" || got[2] != "c" {
		t.Fatalf("dedup must preserve order, got %v", got)
	}
}

func TestReadRefreshTokens_EmptyWhenNoCookie(t *testing.T) {
	opts := &MiddlewareOptions{}
	opts.applyDefaults()
	req := httptest.NewRequest("POST", "/auth/token", nil)
	if got := readRefreshTokens(req, opts); len(got) != 0 {
		t.Fatalf("want none, got %v", got)
	}
}

// ---- the end-to-end incident: a stranded browser refreshes successfully ----

// tokenServer is a minimal issuer that mints only for `liveToken`, exactly as
// the real one behaves for a rotated-away refresh token: an unrecognised hash
// resolves to nothing and comes back 401 refresh_invalid. It does NOT revoke
// anything on a miss — which is what makes trying each candidate safe.
func tokenServer(t *testing.T, liveToken string, calls *int) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/auth/login", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"status": "ok", "subject_type": "platform",
			"access_token": "ptok", "expires_in": 300,
		})
	})
	mux.HandleFunc("/auth/token", func(w http.ResponseWriter, r *http.Request) {
		*calls++
		b, _ := io.ReadAll(r.Body)
		_ = r.Body.Close()
		var probe struct {
			RefreshToken string `json:"refresh_token"`
		}
		_ = json.Unmarshal(b, &probe)
		if probe.RefreshToken != liveToken {
			w.WriteHeader(http.StatusUnauthorized)
			_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]any{
				"code": "refresh_invalid", "message": "refresh token is invalid, expired, or revoked",
			}})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"access_token": "at", "expires_in": 300,
			"tenant_id": "t-1", "role": "member", "refresh_token": "rotated",
		})
	})
	return httptest.NewServer(mux)
}

func TestRefresh_StaleShadowCookieDoesNotStrandTheSession(t *testing.T) {
	calls := 0
	srv := tokenServer(t, "live", &calls)
	defer srv.Close()
	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})

	mw := r.Middleware(MiddlewareOptions{CookieDomain: ".example.com"})
	h := mw(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(404) }))

	req := httptest.NewRequest("POST", "/token", strings.NewReader(`{"tenant_id":"t-1"}`))
	// Stale first — the order a real browser sends, and the reason the old
	// first-match read failed 100% of the time rather than intermittently.
	req.Header.Add("Cookie", "realmid_refresh=stale; realmid_refresh=live")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("a shadowed jar must still refresh, got %d body %s", rec.Code, rec.Body.String())
	}
	if calls != 2 {
		t.Fatalf("want the stale candidate tried then the live one, got %d issuer calls", calls)
	}
}

func TestRefresh_AllCandidatesInvalidStillReportsTheFirstError(t *testing.T) {
	calls := 0
	srv := tokenServer(t, "never-presented", &calls)
	defer srv.Close()
	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})

	mw := r.Middleware(MiddlewareOptions{})
	h := mw(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(404) }))

	req := httptest.NewRequest("POST", "/token", strings.NewReader(`{"tenant_id":"t-1"}`))
	req.Header.Add("Cookie", "realmid_refresh=a; realmid_refresh=b")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	// The error surface must not change shape just because a browser happened
	// to be carrying a stale twin — partners branch on refresh_invalid.
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("want 401, got %d body %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "refresh_invalid") {
		t.Fatalf("want refresh_invalid preserved, got %s", rec.Body.String())
	}
}

// ---- evict the other scopes ----

// setCookiesFor returns the Set-Cookie headers a write emits.
func setCookiesFor(opts MiddlewareOptions, write func(http.ResponseWriter, *MiddlewareOptions)) []string {
	opts.applyDefaults()
	rec := httptest.NewRecorder()
	write(rec, &opts)
	return rec.Result().Header["Set-Cookie"]
}

// Note on the assertions below: Go's http.SetCookie canonicalises the Domain
// attribute and strips a leading dot, so `.example.com` is emitted as
// `Domain=example.com`. Same cookie, per RFC 6265 — the dot has been
// meaningless since RFC 2109 was superseded.
func TestSetRefreshCookie_WithDomainEvictsTheHostOnlyTwin(t *testing.T) {
	got := setCookiesFor(MiddlewareOptions{CookieDomain: ".example.com"},
		func(w http.ResponseWriter, o *MiddlewareOptions) { setRefreshCookie(w, o, "v") })

	if len(got) != 2 {
		t.Fatalf("want a deletion + the write, got %v", got)
	}
	// The host-only deletion carries no Domain attribute — that is precisely
	// what scopes it to the twin rather than to the cookie being written.
	del := got[0]
	if strings.Contains(del, "Domain=") || !strings.Contains(del, "Max-Age=0") {
		t.Fatalf("first header must be a host-only deletion, got %q", del)
	}
	if !strings.Contains(got[1], "Domain=example.com") || !strings.Contains(got[1], "realmid_refresh=v") {
		t.Fatalf("second header must be the live write, got %q", got[1])
	}
}

func TestSetRefreshCookie_HostOnlyEmitsNoStrayDeletion(t *testing.T) {
	got := setCookiesFor(MiddlewareOptions{},
		func(w http.ResponseWriter, o *MiddlewareOptions) { setRefreshCookie(w, o, "v") })

	// The default configuration has no other scope to evict, and inventing one
	// would delete the very cookie being written.
	if len(got) != 1 {
		t.Fatalf("want only the write, got %v", got)
	}
}

func TestSetRefreshCookie_MigrateFromEvictsTheNamedScopes(t *testing.T) {
	got := setCookiesFor(
		MiddlewareOptions{CookieDomainMigrateFrom: []string{".example.com"}},
		func(w http.ResponseWriter, o *MiddlewareOptions) { setRefreshCookie(w, o, "v") })

	// Tightening/removing a domain is the direction the SDK cannot discover on
	// its own: the wider cookie is invisible to a config that no longer writes
	// it, so the partner has to name the scope being left.
	if len(got) != 2 {
		t.Fatalf("want the named deletion + the write, got %v", got)
	}
	if !strings.Contains(got[0], "Domain=example.com") || !strings.Contains(got[0], "Max-Age=0") {
		t.Fatalf("want a deletion for the migrated-from scope, got %q", got[0])
	}
}

func TestEvict_NeverDeletesTheScopeBeingWritten(t *testing.T) {
	// A partner who leaves the old value in MigrateFrom after finishing the
	// migration must not thereby delete their own live cookie on every write.
	got := setCookiesFor(
		MiddlewareOptions{CookieDomain: ".example.com", CookieDomainMigrateFrom: []string{".example.com"}},
		func(w http.ResponseWriter, o *MiddlewareOptions) { setRefreshCookie(w, o, "v") })

	for _, h := range got {
		if strings.Contains(h, "Domain=example.com") && strings.Contains(h, "Max-Age=0") {
			t.Fatalf("must never delete the scope being written: %q", h)
		}
	}
	if !strings.Contains(got[len(got)-1], "realmid_refresh=v") {
		t.Fatalf("the live write must survive, got %v", got)
	}
}

func TestClearRefreshCookie_ClearsEveryScope(t *testing.T) {
	got := setCookiesFor(
		MiddlewareOptions{CookieDomain: ".example.com", CookieDomainMigrateFrom: []string{".old.example.com"}},
		func(w http.ResponseWriter, o *MiddlewareOptions) { clearRefreshCookie(w, o) })

	// Logout clearing only the configured scope is why signing out and back in
	// did not recover a stranded browser.
	if len(got) != 3 {
		t.Fatalf("want host-only + migrated-from + configured deletions, got %v", got)
	}
	for _, h := range got {
		if !strings.Contains(h, "Max-Age=0") {
			t.Fatalf("every header must be a deletion, got %q", h)
		}
	}
}

package realmid

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
)

// identity_resolved_test.go — OnIdentityResolved fires BEFORE the derived-claims
// resolvers, on every lane that resolves them.
//
// # The gap these close
//
// Before this file NO Go test configured `Scopes:` and a side-effecting hook on
// one realm: the resolvers were exercised in derived_claims_lanes_test.go and
// middleware_derived_claims_test.go, the hooks in middleware_hooks_test.go, and
// the two universes never met. Their relative ORDER was therefore untested in
// both directions, which is exactly how a partner ended up resolving scopes
// against a row their own reconciler had not written yet — and paying an extra
// /auth/token round trip on every login, forever, to repair it.
//
// ⚠️ TestIdentityResolvedRunsBeforeScopeResolution is CAUSAL on purpose. A test
// that appends "hook" then "scopes" to a slice is satisfied by any reordering
// that happens to log the same way; a test where the resolver's RETURN VALUE is
// produced by the hook cannot be. Mutation-verified: moving the fire site below
// resolveScopes turns it red.

// scopeMirror is the partner's own store, standing in for the `users` row their
// reconciler writes and their ScopesHandler reads.
type scopeMirror struct {
	rows map[string][]string
}

func newScopeMirror() *scopeMirror { return &scopeMirror{rows: map[string][]string{}} }

func (m *scopeMirror) key(tenantID, userID string) string { return tenantID + "/" + userID }

// TestIdentityResolvedRunsBeforeScopeResolution — THE regression test.
//
// The hook seeds the mirror; Scopes returns nothing but what it finds there. So
// the minted `scope` claim can only be non-empty if the hook ran FIRST. There is
// no ordering assertion anywhere in the test; the ordering is the only thing
// that can produce the asserted value.
func TestIdentityResolvedRunsBeforeScopeResolution(t *testing.T) {
	var got map[string]any
	var calls int32
	srv := laneThenTokenServer(t, "/auth/login", &got, &calls)
	defer srv.Close()

	mirror := newScopeMirror()
	r, _ := NewRealm(Config{
		RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL,
		OnIdentityResolved: func(_ context.Context, ev *IdentityResolvedEvent) error {
			mirror.rows[mirror.key(ev.TenantID, ev.UserID)] = []string{"orders:read"}
			return nil
		},
		ProductRoles: func(_ context.Context, _, _ string) ([]string, error) {
			return []string{"dispatch"}, nil
		},
		Scopes: func(_ context.Context, tenantID, userID string) ([]string, error) {
			return mirror.rows[mirror.key(tenantID, userID)], nil
		},
	})
	if _, err := r.Auth.Login(context.Background(), LoginRequest{
		Method: LoginGoogle, ProviderToken: "tok",
	}); err != nil {
		t.Fatalf("login: %v", err)
	}
	if s, _ := got["scope"].(string); s != "orders:read" {
		t.Fatalf("scope on the mint = %#v, want orders:read — the hook's write was NOT "+
			"visible to the scope resolver, so the resolver ran first", got["scope"])
	}
}

// TestIdentityResolvedFiresOnEveryDerivedClaimsLane — the hook must fire wherever
// its sibling resolvers fire, once, with the lane named.
//
// Lane-specific on purpose: "a login fires the hook" passed throughout the whole
// life of the defect this SDK already shipped twice on this exact surface.
func TestIdentityResolvedFiresOnEveryDerivedClaimsLane(t *testing.T) {
	type lane struct {
		name string
		path string
		want AuthFlow
		call func(r *Realm) error
	}
	lanes := []lane{
		{"Login", "/auth/login", FlowLogin, func(r *Realm) error {
			_, err := r.Auth.Login(context.Background(), LoginRequest{
				Method: LoginGoogle, ProviderToken: "tok",
			})
			return err
		}},
		{"OTPLogin", "/auth/login", FlowOTP, func(r *Realm) error {
			_, err := r.Auth.OTPLogin(context.Background(), OTPLoginRequest{
				Identifier: "u@example.com", Presented: "123456",
			})
			return err
		}},
		{"PasswordLogin", "/auth/login", FlowPassword, func(r *Realm) error {
			_, err := r.Auth.PasswordLogin(context.Background(), PasswordLoginRequest{
				Identifier: "u@example.com", Presented: "pw",
			})
			return err
		}},
		{"MFAVerify", "/auth/mfa/verify", FlowMFAVerify, func(r *Realm) error {
			_, err := r.Auth.MFAVerify(context.Background(), MFAVerifyRequest{
				ChallengeToken: "mfa", Code: "000000",
			})
			return err
		}},
		{"MFAVerifyOTP", "/auth/mfa/verify", FlowMFAVerify, func(r *Realm) error {
			_, err := r.Auth.MFAVerifyOTP(context.Background(), MFAVerifyOTPRequest{
				MFAToken: "mfa", Presented: "000000",
			})
			return err
		}},
	}
	for _, ln := range lanes {
		t.Run(ln.name, func(t *testing.T) {
			var got map[string]any
			var calls int32
			srv := laneThenTokenServer(t, ln.path, &got, &calls)
			defer srv.Close()

			var fired []IdentityResolvedEvent
			r, _ := NewRealm(Config{
				RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL,
				OnIdentityResolved: func(_ context.Context, ev *IdentityResolvedEvent) error {
					fired = append(fired, *ev)
					return nil
				},
			})
			if err := ln.call(r); err != nil {
				t.Fatalf("%s: %v", ln.name, err)
			}
			if len(fired) != 1 {
				t.Fatalf("%s fired the hook %d times, want exactly 1", ln.name, len(fired))
			}
			ev := fired[0]
			if ev.Flow != ln.want {
				t.Errorf("%s Flow = %d, want %d", ln.name, ev.Flow, ln.want)
			}
			if ev.RealmID != testRealmID || ev.TenantID != "t1" || ev.UserID != "u1" {
				t.Errorf("%s event identity = (%q,%q,%q), want (%q,t1,u1)",
					ln.name, ev.RealmID, ev.TenantID, ev.UserID, testRealmID)
			}
			if ev.Role != "owner" {
				t.Errorf("%s event Role = %q, want owner", ln.name, ev.Role)
			}
		})
	}

	// The refresh lane. In a BFF deployment the refresh route IS the
	// tenant-choice route (all three middlewares require tenant_id on it and
	// none has a tenant-choice route), so a hook that skipped refresh would
	// leave the deployment class that asked for this uncovered.
	t.Run("Refresh", func(t *testing.T) {
		cap := &refreshCapture{}
		srv, _ := refreshServer(t, cap)
		defer srv.Close()

		var fired []IdentityResolvedEvent
		r, _ := NewRealm(Config{
			RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL,
			OnIdentityResolved: func(_ context.Context, ev *IdentityResolvedEvent) error {
				fired = append(fired, *ev)
				return nil
			},
		})
		driveRefresh(t, r)
		if len(fired) != 1 {
			t.Fatalf("the refresh lane fired the hook %d times, want exactly 1", len(fired))
		}
		if fired[0].Flow != FlowRefresh {
			t.Errorf("refresh Flow = %d, want FlowRefresh (%d)", fired[0].Flow, FlowRefresh)
		}
		if fired[0].TenantID != "t1" || fired[0].UserID != "u-refresh" {
			t.Errorf("refresh event = (%q,%q), want (t1,u-refresh)",
				fired[0].TenantID, fired[0].UserID)
		}
	})
}

// TestIdentityResolvedFiresOncePerTenant — the guarantee is once per
// DERIVED-CLAIMS RESOLUTION, not once per authentication. A multi-tenant login
// settles no tenant, so there is no identity+tenant pair to announce yet; the
// choice fires it, and a later switch fires it again for the second tenant.
func TestIdentityResolvedFiresOncePerTenant(t *testing.T) {
	var mints int32
	srv := authTestServer(t, map[string]http.HandlerFunc{
		"/auth/login": func(w http.ResponseWriter, _ *http.Request) {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"refresh_token": "rtok",
				"user":          map[string]any{"id": "u1"},
				"tenants": []any{
					map[string]any{"tenant_id": "t1", "role": "owner"},
					map[string]any{"tenant_id": "t2", "role": "member"},
				},
			})
		},
		"/auth/token": func(w http.ResponseWriter, _ *http.Request) {
			atomic.AddInt32(&mints, 1)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"access_token": "minted", "refresh_token": "rtok2", "expires_in": 900,
			})
		},
	})
	defer srv.Close()

	var fired []IdentityResolvedEvent
	r, _ := NewRealm(Config{
		RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL,
		OnIdentityResolved: func(_ context.Context, ev *IdentityResolvedEvent) error {
			fired = append(fired, *ev)
			return nil
		},
		Scopes: func(_ context.Context, _, _ string) ([]string, error) {
			return []string{"orders:read"}, nil
		},
	})
	s, err := r.Auth.Login(context.Background(), LoginRequest{
		Method: LoginGoogle, ProviderToken: "tok",
	})
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	if !s.NeedsTenantChoice() {
		t.Fatalf("want a multi-tenant login that needs a choice")
	}
	if len(fired) != 0 {
		t.Fatalf("a multi-tenant login fired the hook %d times — no tenant is settled, "+
			"so there is no (identity, tenant) to announce", len(fired))
	}
	if err := r.Auth.CompleteLogin(context.Background(), s, "t1", nil); err != nil {
		t.Fatalf("complete t1: %v", err)
	}
	if len(fired) != 1 || fired[0].TenantID != "t1" || fired[0].Flow != FlowTenantChoice {
		t.Fatalf("after CompleteLogin(t1) fired = %+v, want one FlowTenantChoice event for t1", fired)
	}
	if err := r.Auth.CompleteLogin(context.Background(), s, "t2", nil); err != nil {
		t.Fatalf("complete t2: %v", err)
	}
	if len(fired) != 2 || fired[1].TenantID != "t2" {
		t.Fatalf("a tenant SWITCH must fire again for the new tenant; fired = %+v", fired)
	}
	if fired[0].Role != "owner" || fired[1].Role != "member" {
		t.Errorf("roles = (%q,%q), want (owner,member)", fired[0].Role, fired[1].Role)
	}
}

// TestIdentityResolvedErrorRefusesTheMint — the hook's error refuses the mint,
// unconditionally and with no knob. A partner who wants best-effort returns nil.
//
// The refusal is not new authority: a failing Config.Scopes already fails every
// login on that realm today. What is asserted here is that the refusal happens
// BEFORE the mint (no /auth/token leaves) and that the session rides the
// LoginMintError recovery anchor rather than being dropped on the floor.
func TestIdentityResolvedErrorRefusesTheMint(t *testing.T) {
	var got map[string]any
	var calls int32
	srv := laneThenTokenServer(t, "/auth/login", &got, &calls)
	defer srv.Close()

	boom := errors.New("mirror store down")
	var resolverCalls int32
	r, _ := NewRealm(Config{
		RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL,
		OnIdentityResolved: func(_ context.Context, _ *IdentityResolvedEvent) error {
			return boom
		},
		Scopes: func(_ context.Context, _, _ string) ([]string, error) {
			atomic.AddInt32(&resolverCalls, 1)
			return []string{"orders:read"}, nil
		},
	})
	_, err := r.Auth.Login(context.Background(), LoginRequest{
		Method: LoginGoogle, ProviderToken: "tok",
	})
	if err == nil {
		t.Fatal("want the login mint refused, got nil error")
	}
	if calls != 0 {
		t.Errorf("%d /auth/token mints were made after the hook failed, want 0", calls)
	}
	if resolverCalls != 0 {
		t.Errorf("the scope resolver ran %d times after the hook failed, want 0", resolverCalls)
	}
	var ire *IdentityResolvedError
	if !errors.As(err, &ire) {
		t.Fatalf("error %T does not unwrap to *IdentityResolvedError", err)
	}
	if !errors.Is(err, boom) {
		t.Errorf("the partner's own error must survive unwrapping; got %v", err)
	}
	// NOT retried. The resolvers are retried three times because they are
	// specified side-effect-free; this one is specified side-effecting, so it
	// runs exactly once and the retry is the user's.
	var mint *LoginMintError
	if !errors.As(err, &mint) {
		t.Fatalf("error %T is not a *LoginMintError — the session is the ADR-102 OQ8 "+
			"recovery anchor and must ride the error", err)
	}
	if mint.Session == nil || mint.Session.RefreshToken != "rtok" {
		t.Errorf("LoginMintError.Session = %+v, want the intact session /auth/login created",
			mint.Session)
	}
}

// TestIdentityResolvedFiresExactlyOnceOnFailure pins the "not retried" half of
// the contract. The resolvers run up to productRolesAttempts times; this hook
// must not, because it is the SIDE-EFFECTING one.
func TestIdentityResolvedFiresExactlyOnceOnFailure(t *testing.T) {
	var got map[string]any
	var calls int32
	srv := laneThenTokenServer(t, "/auth/login", &got, &calls)
	defer srv.Close()

	var fires int32
	r, _ := NewRealm(Config{
		RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL,
		OnIdentityResolved: func(_ context.Context, _ *IdentityResolvedEvent) error {
			atomic.AddInt32(&fires, 1)
			return errors.New("nope")
		},
	})
	if _, err := r.Auth.Login(context.Background(), LoginRequest{
		Method: LoginGoogle, ProviderToken: "tok",
	}); err == nil {
		t.Fatal("want the mint refused")
	}
	if fires != 1 {
		t.Errorf("the hook ran %d times, want exactly 1 — a side-effecting hook that is "+
			"retried writes twice and the partner is right to call it a bug", fires)
	}
}

// TestIdentityResolvedEventMutationIsInert — the event is a pointer for
// allocation reasons only. A hook that rewrites TenantID must not thereby
// redirect the resolution: the issuer authenticated one (user, tenant) pair and
// the claims must be resolved for that pair.
func TestIdentityResolvedEventMutationIsInert(t *testing.T) {
	var got map[string]any
	var calls int32
	srv := laneThenTokenServer(t, "/auth/login", &got, &calls)
	defer srv.Close()

	var sawTenant, sawUser string
	r, _ := NewRealm(Config{
		RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL,
		OnIdentityResolved: func(_ context.Context, ev *IdentityResolvedEvent) error {
			ev.TenantID = "t-evil"
			ev.UserID = "u-evil"
			ev.RealmID = "r-evil"
			return nil
		},
		Scopes: func(_ context.Context, tenantID, userID string) ([]string, error) {
			sawTenant, sawUser = tenantID, userID
			return []string{"orders:read"}, nil
		},
	})
	if _, err := r.Auth.Login(context.Background(), LoginRequest{
		Method: LoginGoogle, ProviderToken: "tok",
	}); err != nil {
		t.Fatalf("login: %v", err)
	}
	if sawTenant != "t1" || sawUser != "u1" {
		t.Errorf("the scope resolver got (%q,%q) — a hook mutated the event and the "+
			"resolution followed it; want (t1,u1)", sawTenant, sawUser)
	}
}

// TestIdentityResolvedRefusesRefreshWhenSubjectIsUnreadable — §4.3.2.
//
// The peek branch degrades SILENTLY today, and that is right for a resolver-only
// consumer: the claim is omitted and the refresh survives. With the hook
// configured it is wrong, because "identity is known" is the hook's whole
// contract and silently not firing is precisely the failure the partner
// reported. So the branch refuses the refresh — and ONLY when the hook is set.
func TestIdentityResolvedRefusesRefreshWhenSubjectIsUnreadable(t *testing.T) {
	var mints int32
	srv := authTestServer(t, map[string]http.HandlerFunc{
		"/auth/token": func(w http.ResponseWriter, _ *http.Request) {
			atomic.AddInt32(&mints, 1)
			_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "x"})
		},
	})
	defer srv.Close()

	unreadable := func() *MintResult {
		return &MintResult{AccessToken: "not-a-jwt", RefreshToken: "rtok2", TenantID: "t1"}
	}

	t.Run("degrades without the hook", func(t *testing.T) {
		r, _ := NewRealm(Config{
			RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL,
			Scopes: func(_ context.Context, _, _ string) ([]string, error) {
				return []string{"orders:read"}, nil
			},
		})
		if err := r.enrichRefreshMint(context.Background(), unreadable(), "t1"); err != nil {
			t.Fatalf("an unreadable sub must still degrade to today's behaviour for a "+
				"resolver-only consumer; got %v", err)
		}
	})

	t.Run("refuses with the hook", func(t *testing.T) {
		var fires int32
		r, _ := NewRealm(Config{
			RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL,
			OnIdentityResolved: func(_ context.Context, _ *IdentityResolvedEvent) error {
				atomic.AddInt32(&fires, 1)
				return nil
			},
		})
		err := r.enrichRefreshMint(context.Background(), unreadable(), "t1")
		if err == nil {
			t.Fatal("an unreadable sub with the hook configured must REFUSE the refresh — " +
				"silently not firing is the exact failure this hook exists to end")
		}
		var ire *IdentityResolvedError
		if !errors.As(err, &ire) {
			t.Errorf("error %T does not unwrap to *IdentityResolvedError", err)
		}
		if fires != 0 {
			t.Errorf("the hook fired %d times without a known identity, want 0", fires)
		}
	})
}

// TestIdentityResolvedFiresOnRefreshWithNoResolvers — the enrichRefreshMint
// short-circuit must consult the hook. A hook-only consumer configures no
// resolver at all, and the old guard (`both nil -> return`) would have made the
// refresh lane silently dead for exactly them.
func TestIdentityResolvedFiresOnRefreshWithNoResolvers(t *testing.T) {
	cap := &refreshCapture{}
	srv, _ := refreshServer(t, cap)
	defer srv.Close()

	var fires int32
	r, _ := NewRealm(Config{
		RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL,
		OnIdentityResolved: func(_ context.Context, _ *IdentityResolvedEvent) error {
			atomic.AddInt32(&fires, 1)
			return nil
		},
	})
	driveRefresh(t, r)
	if fires != 1 {
		t.Fatalf("a hook-only consumer got %d fires on refresh, want 1", fires)
	}
	// And no second mint: with both resolvers nil there is no claim to add, so
	// the re-mint would only reproduce the token we already hold.
	if n := len(cap.snapshot()); n != 1 {
		t.Errorf("%d /auth/token calls on the refresh lane, want 1 — firing the hook must "+
			"not buy a round trip for a consumer with no claims to mint", n)
	}
}

// TestAuthFlowValuesAreDistinct — the three lanes this change adds are declared
// in identity_resolved.go, relative to the last constant in middleware.go, so a
// constant appended THERE would silently collide and two lanes would become
// indistinguishable to a partner switching on Flow.
func TestAuthFlowValuesAreDistinct(t *testing.T) {
	seen := map[AuthFlow]string{}
	for _, f := range []struct {
		v AuthFlow
		n string
	}{
		{FlowLogin, "FlowLogin"},
		{FlowRefresh, "FlowRefresh"},
		{FlowMFAVerify, "FlowMFAVerify"},
		{FlowOTP, "FlowOTP"},
		{FlowPassword, "FlowPassword"},
		{FlowTenantChoice, "FlowTenantChoice"},
	} {
		if prev, dup := seen[f.v]; dup {
			t.Errorf("%s and %s are both %d — a partner switching on Flow cannot tell "+
				"the two lanes apart", prev, f.n, f.v)
		}
		seen[f.v] = f.n
	}
}

// TestEveryResolverCallSiteAlsoFiresTheHook — §10.2's AST guard.
//
// ⚠️ IT PROVES CO-OCCURRENCE, NOT ORDER. A fire site moved BELOW the resolvers
// still satisfies it, which is why TestIdentityResolvedRunsBeforeScopeResolution
// exists and why neither substitutes for the other. What this one catches is the
// failure mode that produced this work in the first place: a NEW resolver call
// site added later without a fire site, on a lane nobody remembered.
func TestEveryResolverCallSiteAlsoFiresTheHook(t *testing.T) {
	funcs := parsePackageFuncs(t)

	const fire = "fireIdentityResolved"
	if _, ok := funcs[fire]; !ok {
		t.Fatalf("%s is not in the package — this guard is keyed on a name that no "+
			"longer exists and would pass vacuously from here on", fire)
	}

	resolvers := []string{"resolveProductRoles", "resolveScopes"}
	var sites, missing []string
	for name, fn := range funcs {
		if name == fire {
			continue
		}
		var calls bool
		for _, res := range resolvers {
			if fn.calls[res] {
				calls = true
			}
		}
		// The resolvers' own definitions are not call sites.
		if !calls || name == "resolveProductRoles" || name == "resolveScopes" {
			continue
		}
		sites = append(sites, name)
		if !fn.calls[fire] {
			missing = append(missing, name+" ("+fn.pos.Filename+":"+strconv.Itoa(fn.pos.Line)+")")
		}
	}
	sort.Strings(sites)
	sort.Strings(missing)

	// A guard with no subjects is not a passing guard: the package has at least
	// mintProductRoles and enrichRefreshMint.
	if len(sites) < 2 {
		t.Fatalf("found only %d derived-claims resolution sites (%v) — the detection is "+
			"broken and this guard is checking nothing", len(sites), sites)
	}
	if len(missing) > 0 {
		t.Errorf("these functions resolve the derived claims without announcing the "+
			"identity first:\n  %s\n\nA partner whose ScopesHandler reads a row their "+
			"%s writes gets a scope-less token on this lane. Call %s before the "+
			"resolvers.", strings.Join(missing, "\n  "), fire, fire)
	}
	t.Logf("%d derived-claims resolution sites checked against %s: %s",
		len(sites), fire, strings.Join(sites, ", "))
}

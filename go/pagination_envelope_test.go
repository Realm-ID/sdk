package realmid

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"testing"
)

// TestPageRoundTrip is the guard this class of bug needs.
//
// A DECODE-ONLY assertion ("the field arrived") passes whether or not the field
// is carried onward — which is exactly how go/v0.53.0 silently deleted
// `credential_methods`: the BFF decoded discovery into an SDK type and
// RE-SERIALISED it, and every layer's own suite was green. So this test decodes
// the wire envelope into the SDK type and RE-ENCODES it, asserting every
// pagination field survives the trip with its wire key intact.
func TestPageRoundTrip(t *testing.T) {
	const wire = `{"items":[{"id":"a"}],"next_cursor":"cur-2","has_more":true,"total":97}`

	var p Page[map[string]string]
	if err := json.Unmarshal([]byte(wire), &p); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if p.NextCursor != "cur-2" {
		t.Errorf("NextCursor = %q, want cur-2", p.NextCursor)
	}
	if !p.HasMore {
		t.Errorf("HasMore = false, want true")
	}
	if p.Total == nil || *p.Total != 97 {
		t.Errorf("Total = %v, want 97", p.Total)
	}

	out, err := json.Marshal(p)
	if err != nil {
		t.Fatalf("re-encode: %v", err)
	}
	var got map[string]any
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatalf("re-decode: %v", err)
	}
	for k, want := range map[string]any{
		"next_cursor": "cur-2",
		"has_more":    true,
		"total":       float64(97),
	} {
		if got[k] != want {
			t.Errorf("re-encoded %q = %v (%T), want %v — field dropped on the way OUT", k, got[k], got[k], want)
		}
	}
	items, _ := got["items"].([]any)
	if len(items) != 1 {
		t.Errorf("re-encoded items = %v, want 1 element", got["items"])
	}
}

// TestPageRoundTrip_HasMoreFalseIsCarried pins the asymmetry that `omitempty`
// would break: `has_more:false` is a real answer ("this is the last page"), not
// an absent one, so it must survive re-encoding as an explicit false.
func TestPageRoundTrip_HasMoreFalseIsCarried(t *testing.T) {
	var p Page[map[string]string]
	if err := json.Unmarshal([]byte(`{"items":[],"next_cursor":null,"has_more":false}`), &p); err != nil {
		t.Fatalf("decode: %v", err)
	}
	out, err := json.Marshal(p)
	if err != nil {
		t.Fatalf("re-encode: %v", err)
	}
	var got map[string]any
	_ = json.Unmarshal(out, &got)
	v, present := got["has_more"]
	if !present {
		t.Fatalf("re-encoded envelope has no has_more key at all: %s", out)
	}
	if v != false {
		t.Errorf("re-encoded has_more = %v, want false", v)
	}
}

// pagedListServer answers `path` with a two-page walk keyed on ?cursor=.
func pagedListServer(t *testing.T, path string, first, second map[string]any) (string, func()) {
	t.Helper()
	srv := authTestServer(t, map[string]http.HandlerFunc{
		path: func(w http.ResponseWriter, r *http.Request) {
			body := first
			if r.URL.Query().Get("cursor") == "cur-2" {
				body = second
			}
			_ = json.NewEncoder(w).Encode(body)
		},
	})
	return srv.URL, srv.Close
}

func page1(items ...any) map[string]any {
	return map[string]any{"items": items, "next_cursor": "cur-2", "has_more": true, "total": 3}
}

func page2(items ...any) map[string]any {
	return map[string]any{"items": items, "next_cursor": nil, "has_more": false, "total": 3}
}

// TestSourcesList_ExposesEnvelope asserts SourcesClient.List surfaces the
// pagination envelope instead of discarding it, and that .All walks both pages.
func TestSourcesList_ExposesEnvelope(t *testing.T) {
	base, done := pagedListServer(t, "/sources",
		page1(map[string]any{"id": "s1", "platform_id": testRealmID, "type": "web", "label": "one"}),
		page2(map[string]any{"id": "s2", "platform_id": testRealmID, "type": "web", "label": "two"}),
	)
	defer done()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: base})
	list := r.Sources.List(context.Background())
	pg, err := list.Page(context.Background(), nil)
	if err != nil {
		t.Fatalf("Page: %v", err)
	}
	if len(pg.Items) != 1 || pg.Items[0].ID != "s1" {
		t.Errorf("Items = %+v", pg.Items)
	}
	if pg.NextCursor != "cur-2" || !pg.HasMore {
		t.Errorf("NextCursor=%q HasMore=%v — envelope discarded", pg.NextCursor, pg.HasMore)
	}
	if pg.Total == nil || *pg.Total != 3 {
		t.Errorf("Total = %v", pg.Total)
	}
	var ids []string
	for s, err := range list.All(context.Background()) {
		if err != nil {
			t.Fatalf("All: %v", err)
		}
		ids = append(ids, s.ID)
	}
	if len(ids) != 2 || ids[0] != "s1" || ids[1] != "s2" {
		t.Errorf("All walked %v, want [s1 s2] — pager stopped at page one", ids)
	}
}

// TestServiceAccountsList_ExposesEnvelope — same guard on the S5 endpoint.
func TestServiceAccountsList_ExposesEnvelope(t *testing.T) {
	base, done := pagedListServer(t, "/tenants/t1/service-accounts",
		page1(map[string]any{"id": "sa1", "handle": "a@x.test", "role": "member", "status": "active", "kind": "service"}),
		page2(map[string]any{"id": "sa2", "handle": "b@x.test", "role": "member", "status": "active", "kind": "service"}),
	)
	defer done()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: base})
	list := r.ServiceAccounts.List(context.Background(), "t1")
	pg, err := list.Page(context.Background(), nil)
	if err != nil {
		t.Fatalf("Page: %v", err)
	}
	if pg.NextCursor != "cur-2" || !pg.HasMore {
		t.Errorf("NextCursor=%q HasMore=%v — envelope discarded", pg.NextCursor, pg.HasMore)
	}
	var n int
	for _, err := range list.All(context.Background()) {
		if err != nil {
			t.Fatalf("All: %v", err)
		}
		n++
	}
	if n != 2 {
		t.Errorf("All walked %d, want 2", n)
	}
}

// TestUserAPIKeysList_ExposesEnvelope — the S6 endpoint, the one a partner is
// most likely to be reading.
func TestUserAPIKeysList_ExposesEnvelope(t *testing.T) {
	base, done := pagedListServer(t, "/tenants/t1/users/u1/user-api-keys",
		page1(map[string]any{"id": "k1", "prefix": "uk_live_a", "label": "one"}),
		page2(map[string]any{"id": "k2", "prefix": "uk_live_b", "label": "two"}),
	)
	defer done()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: base})
	list := r.UserAPIKeys.List(context.Background(), "t1", "u1")
	pg, err := list.Page(context.Background(), &PageOpts{Limit: 1})
	if err != nil {
		t.Fatalf("Page: %v", err)
	}
	if pg.NextCursor != "cur-2" || !pg.HasMore {
		t.Errorf("NextCursor=%q HasMore=%v — envelope discarded", pg.NextCursor, pg.HasMore)
	}
	var n int
	for _, err := range list.All(context.Background()) {
		if err != nil {
			t.Fatalf("All: %v", err)
		}
		n++
	}
	if n != 2 {
		t.Errorf("All walked %d, want 2", n)
	}
}

// TestAPIKeysList_ExposesEnvelope — the platform-key list, found by sweep and
// not named in the original report. Its own doc comment already said the issuer
// returns {items, next_cursor, total} and then threw it away.
func TestAPIKeysList_ExposesEnvelope(t *testing.T) {
	path := "/platforms/" + url.PathEscape(testRealmID) + "/api-keys"
	base, done := pagedListServer(t, path,
		page1(map[string]any{"id": "ak1", "prefix": "rk_live_a"}),
		page2(map[string]any{"id": "ak2", "prefix": "rk_live_b"}),
	)
	defer done()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: base})
	list := r.APIKeys.List(context.Background())
	pg, err := list.Page(context.Background(), nil)
	if err != nil {
		t.Fatalf("Page: %v", err)
	}
	if pg.NextCursor != "cur-2" || !pg.HasMore {
		t.Errorf("NextCursor=%q HasMore=%v — envelope discarded", pg.NextCursor, pg.HasMore)
	}
	var n int
	for _, err := range list.All(context.Background()) {
		if err != nil {
			t.Fatalf("All: %v", err)
		}
		n++
	}
	if n != 2 {
		t.Errorf("All walked %d, want 2", n)
	}
}

// TestPagerStopsOnHasMoreFalse pins the terminator: a server that answers a
// non-empty next_cursor together with has_more:false must not send the walk
// round again. next_cursor alone was the only terminator before, so a
// mis-set cursor looped or over-read.
func TestPagerStopsOnHasMoreFalse(t *testing.T) {
	var calls int
	srv := authTestServer(t, map[string]http.HandlerFunc{
		"/sources": func(w http.ResponseWriter, _ *http.Request) {
			calls++
			_ = json.NewEncoder(w).Encode(map[string]any{
				"items":       []any{map[string]any{"id": "s1", "type": "web", "label": "one"}},
				"next_cursor": "cur-9",
				"has_more":    false,
			})
		},
	})
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	var n int
	for _, err := range r.Sources.List(context.Background()).All(context.Background()) {
		if err != nil {
			t.Fatalf("All: %v", err)
		}
		n++
		if n > 5 {
			t.Fatalf("pager did not terminate on has_more:false")
		}
	}
	if calls != 1 {
		t.Errorf("server called %d times, want 1 — has_more:false is the terminator", calls)
	}
}

// TestUnsetLimitAndCursorAreOMITTEDFromTheQuery asserts the SERIALISED URL, not
// the intent of the code above it.
//
// The issuer now answers 400 invalid_limit to `limit=0` and 400 invalid_cursor
// to a malformed cursor, where both were previously absorbed into the defaults.
// Go's PageOpts.Limit is an int, so an omitted limit IS the zero value — if the
// query builder serialised that as `limit=0`, every list call in the SDK would
// 400 against a real server while passing every unit test here. That is exactly
// the shape of bug a wire-level assertion catches and a value-level one does
// not, so this reads the raw query string.
func TestUnsetLimitAndCursorAreOMITTEDFromTheQuery(t *testing.T) {
	var gotQuery string
	srv := authTestServer(t, map[string]http.HandlerFunc{
		"/sources": func(w http.ResponseWriter, r *http.Request) {
			gotQuery = r.URL.RawQuery
			_ = json.NewEncoder(w).Encode(map[string]any{
				"items": []any{}, "next_cursor": nil, "has_more": false,
			})
		},
	})
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})

	// A bare .Page(ctx, nil): PageOpts is the zero value throughout.
	if _, err := r.Sources.List(context.Background()).Page(context.Background(), nil); err != nil {
		t.Fatalf("Page: %v", err)
	}
	q, err := url.ParseQuery(gotQuery)
	if err != nil {
		t.Fatalf("parse query %q: %v", gotQuery, err)
	}
	if _, present := q["limit"]; present {
		t.Errorf("query = %q — an unset limit must be ABSENT, not limit=0 (400 invalid_limit)", gotQuery)
	}
	if _, present := q["cursor"]; present {
		t.Errorf("query = %q — an unset cursor must be ABSENT, not cursor= (400 invalid_cursor)", gotQuery)
	}
	// The endpoint's own required param is still there — proof the query was
	// built at all, so the assertions above are not passing on an empty string.
	if q.Get("platform_id") != testRealmID {
		t.Errorf("query = %q — expected platform_id, so this test is not vacuous", gotQuery)
	}

	// An explicitly-zero limit is the same wire outcome: Go cannot distinguish
	// it from unset, and 0 is not a limit a caller can mean.
	if _, err := r.Sources.List(context.Background()).Page(context.Background(), &PageOpts{Limit: 0}); err != nil {
		t.Fatalf("Page: %v", err)
	}
	if q, _ := url.ParseQuery(gotQuery); q.Has("limit") {
		t.Errorf("query = %q — PageOpts{Limit: 0} must not serialise limit=0", gotQuery)
	}

	// A real limit IS sent — the omission above is a guard, not a dropped field.
	if _, err := r.Sources.List(context.Background()).Page(context.Background(), &PageOpts{Limit: 25, Cursor: "c1"}); err != nil {
		t.Fatalf("Page: %v", err)
	}
	q, _ = url.ParseQuery(gotQuery)
	if q.Get("limit") != "25" || q.Get("cursor") != "c1" {
		t.Errorf("query = %q — a set limit/cursor must be sent", gotQuery)
	}
}

// TestEveryPagedListOmitsAnUnsetLimit is the same assertion across all four
// methods this change converted, because each builds its own query map and a
// per-method regression would otherwise only show against a live server.
func TestEveryPagedListOmitsAnUnsetLimit(t *testing.T) {
	queries := map[string]string{}
	empty := func(name string) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			queries[name] = r.URL.RawQuery
			_ = json.NewEncoder(w).Encode(map[string]any{
				"items": []any{}, "next_cursor": nil, "has_more": false,
			})
		}
	}
	srv := authTestServer(t, map[string]http.HandlerFunc{
		"/sources":                                empty("sources"),
		"/tenants/t1/service-accounts":            empty("service-accounts"),
		"/tenants/t1/users/u1/user-api-keys":      empty("user-api-keys"),
		"/platforms/" + testRealmID + "/api-keys": empty("api-keys"),
	})
	defer srv.Close()

	ctx := context.Background()
	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})

	if _, err := r.Sources.List(ctx).Page(ctx, nil); err != nil {
		t.Fatalf("sources: %v", err)
	}
	if _, err := r.ServiceAccounts.List(ctx, "t1").Page(ctx, nil); err != nil {
		t.Fatalf("service-accounts: %v", err)
	}
	if _, err := r.UserAPIKeys.List(ctx, "t1", "u1").Page(ctx, nil); err != nil {
		t.Fatalf("user-api-keys: %v", err)
	}
	if _, err := r.APIKeys.List(ctx).Page(ctx, nil); err != nil {
		t.Fatalf("api-keys: %v", err)
	}

	if len(queries) != 4 {
		t.Fatalf("only %d of 4 endpoints were called: %v", len(queries), queries)
	}
	for name, raw := range queries {
		q, err := url.ParseQuery(raw)
		if err != nil {
			t.Fatalf("%s: parse %q: %v", name, raw, err)
		}
		if q.Has("limit") {
			t.Errorf("%s: query %q sends limit — an unset limit must be omitted", name, raw)
		}
		if q.Has("cursor") {
			t.Errorf("%s: query %q sends cursor — an unset cursor must be omitted", name, raw)
		}
	}
}

// TestPaginationInputErrorsReachCode asserts the caller-visible claim, not the
// registry entry: a 400 invalid_limit / invalid_cursor must surface on
// RealmError.Code so a caller can BRANCH on it.
//
// This is the assertion go/v0.52.0 lacked — it shipped four ADR-101 codes
// missing from the taxonomy, and an unregistered code collapses to a bare
// `bad_request` on Code while ts and Java see the precise string. The taxonomy
// test proves the constant exists; only this proves it arrives.
func TestPaginationInputErrorsReachCode(t *testing.T) {
	for _, tc := range []struct {
		code string
		want ErrorCode
	}{
		{"invalid_limit", ErrCodeInvalidLimit},
		{"invalid_cursor", ErrCodeInvalidCursor},
	} {
		t.Run(tc.code, func(t *testing.T) {
			srv := authTestServer(t, map[string]http.HandlerFunc{
				"/sources": func(w http.ResponseWriter, _ *http.Request) {
					w.WriteHeader(http.StatusBadRequest)
					_ = json.NewEncoder(w).Encode(map[string]any{
						"error": "bad pagination input", "code": tc.code,
					})
				},
			})
			defer srv.Close()

			r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
			_, err := r.Sources.List(context.Background()).Page(context.Background(), nil)
			if err == nil {
				t.Fatal("expected an error")
			}
			var re *RealmError
			if !errors.As(err, &re) {
				t.Fatalf("not a RealmError: %v", err)
			}
			if re.Code != tc.want {
				t.Errorf("Code = %q, want %q — an unregistered code collapses to bad_request and cannot be branched on", re.Code, tc.want)
			}
		})
	}
}

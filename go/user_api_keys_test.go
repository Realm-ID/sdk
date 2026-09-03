package realmid

import (
	ctxpkg "context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"testing"
)

// CapAllows is the one helper in this SDK whose SIGNATURE is a security control
// (SPEC §6.6.2): the live-permission resolver is a required third operand, so the
// insecure one-operand form — "does the cap list this permission?" — cannot be
// written through this API at all.

func capClaims(entries ...string) *Claims {
	// []any is what a JSON-decoded token actually yields; the []string case is
	// covered separately.
	vals := make([]any, 0, len(entries))
	for _, e := range entries {
		vals = append(vals, e)
	}
	return &Claims{Extra: map[string]any{"permissions_cap": vals}}
}

func liveOf(perms ...string) LivePermissionResolver {
	return func(ctxpkg.Context) ([]string, error) { return perms, nil }
}

func TestCapAllows_RequiresBothOperands(t *testing.T) {
	ctx := ctxpkg.Background()

	// In cap AND live → allowed.
	if !CapAllows(ctx, capClaims("reports:read"), "reports:read", liveOf("reports:read", "users:read")) {
		t.Error("a permission in BOTH the cap and the live set must be allowed")
	}
	// In cap but NOT live: the holder's role shrank. This is the case the whole
	// design exists for — a stale cap must not resurrect lost authority.
	if CapAllows(ctx, capClaims("users:manage"), "users:manage", liveOf("reports:read")) {
		t.Error("a cap entry the holder no longer LIVES must be denied")
	}
	// In live but NOT cap: the key is narrower than the human.
	if CapAllows(ctx, capClaims("reports:read"), "users:manage", liveOf("users:manage")) {
		t.Error("a live permission outside the cap must be denied")
	}
}

func TestCapAllows_FailsClosed(t *testing.T) {
	ctx := ctxpkg.Background()
	claims := capClaims("reports:read")

	// A resolver error means the live operand is unknown, and the only safe
	// reading of an unknown intersection is empty.
	boom := func(ctxpkg.Context) ([]string, error) { return nil, errors.New("store down") }
	if CapAllows(ctx, claims, "reports:read", boom) {
		t.Error("a resolver error must fail CLOSED")
	}
	// A nil resolver is the same situation, and is also the shape a caller would
	// reach for if they wanted the one-operand version.
	if CapAllows(ctx, claims, "reports:read", nil) {
		t.Error("a nil resolver must fail CLOSED, never degrade to a cap-only check")
	}
	if CapAllows(ctx, nil, "reports:read", liveOf("reports:read")) {
		t.Error("nil claims must fail CLOSED")
	}
	if CapAllows(ctx, claims, "", liveOf("reports:read")) {
		t.Error("an empty permission must fail CLOSED")
	}
}

func TestCapAllows_AbsentVsEmptyCap(t *testing.T) {
	ctx := ctxpkg.Background()

	// ABSENT cap = not a key-derived token = not capped. Only the live set
	// governs, so an ordinary session keeps working through this helper.
	uncapped := &Claims{Extra: map[string]any{"scope": "platform"}}
	if !CapAllows(ctx, uncapped, "users:manage", liveOf("users:manage")) {
		t.Error("a token with NO permissions_cap is uncapped; the live set alone governs")
	}
	if CapAllows(ctx, uncapped, "users:manage", liveOf("reports:read")) {
		t.Error("uncapped still requires the LIVE permission")
	}
	// Nil Extra behaves the same way.
	if !CapAllows(ctx, &Claims{}, "users:manage", liveOf("users:manage")) {
		t.Error("nil Extra means uncapped, not capped-to-nothing")
	}

	// PRESENT but EMPTY = capped to nothing = deny everything. Conflating this
	// with "absent" would turn every empty-cap key into a full-authority one,
	// which is the worst direction for the bug to go.
	//
	// ⚠️ ADR-100 made this a state the SERVER CAN NO LONGER PRODUCE: {} is not a
	// storable cap, and an empty intersection at mint is a 403 rather than an
	// empty claim. This assertion is deliberately kept anyway. It is not dead
	// coverage — it pins the behaviour for a claim that arrives GARBLED or
	// hostile off the wire, where "I am capped, to something unreadable" must
	// still read as "to nothing". We no longer emit the state; we still deny on
	// it. Do not delete it on the grounds that the issuer cannot reach it.
	empty := &Claims{Extra: map[string]any{"permissions_cap": []any{}}}
	if CapAllows(ctx, empty, "users:manage", liveOf("users:manage")) {
		t.Error("a PRESENT but empty cap means capped to nothing and must deny everything")
	}
}

func TestCapAllows_MalformedCapIsCappedToNothing(t *testing.T) {
	ctx := ctxpkg.Background()
	for name, raw := range map[string]any{
		"a string":  "reports:read",
		"a number":  42,
		"an object": map[string]any{"reports": "read"},
	} {
		claims := &Claims{Extra: map[string]any{"permissions_cap": raw}}
		if CapAllows(ctx, claims, "reports:read", liveOf("reports:read")) {
			t.Errorf("%s: a present-but-unparseable cap must be read as capped to nothing", name)
		}
	}
	// A []string cap (claims assembled in Go rather than decoded from JSON) is
	// accepted.
	claims := &Claims{Extra: map[string]any{"permissions_cap": []string{"reports:read"}}}
	if !CapAllows(ctx, claims, "reports:read", liveOf("reports:read")) {
		t.Error("a []string cap should be accepted")
	}
	// A mixed array keeps the strings it understood: dropping junk only narrows,
	// which is always safe.
	mixed := &Claims{Extra: map[string]any{"permissions_cap": []any{"reports:read", 7}}}
	if !CapAllows(ctx, mixed, "reports:read", liveOf("reports:read")) {
		t.Error("a mixed array should keep its valid entries")
	}
}

func TestCapAllows_NoWildcardOrHierarchy(t *testing.T) {
	ctx := ctxpkg.Background()
	// RealmID never expands wildcards, applies hierarchy, or implies `*`, and
	// neither may the SDK — a partner who saw "users:*" work here would build a
	// mental model the server does not share.
	if CapAllows(ctx, capClaims("users:*"), "users:read", liveOf("users:read")) {
		t.Error("a wildcard must NOT be expanded")
	}
	if CapAllows(ctx, capClaims("users"), "users:read", liveOf("users:read")) {
		t.Error("a prefix must NOT match — no hierarchy")
	}
	if CapAllows(ctx, capClaims("Users:Read"), "users:read", liveOf("users:read")) {
		t.Error("matching must be exact, not case-folded")
	}
}

func TestUserAPIKey_RevokedAndListDecoding(t *testing.T) {
	live := UserAPIKey{ID: "k1"}
	if live.Revoked() {
		t.Error("a key with no revoked_at is not revoked")
	}
	ts := int64(1000)
	if !(UserAPIKey{ID: "k2", RevokedAt: &ts}).Revoked() {
		t.Error("a key with revoked_at IS revoked")
	}

	// The issuer's paginated envelope, decoded through the shared Page type.
	// The flat-array and "any other shape" cases are gone with
	// decodeUserAPIKeyList: SPEC §7 locks the wire to {items, next_cursor,
	// has_more}, fetchPage rejects anything else with a server_error, and a
	// per-endpoint tolerance was the thing letting this list drift from every
	// other paginated list in the SDK.
	var pg Page[UserAPIKey]
	if err := json.Unmarshal([]byte(`{"items":[{"id":"a","prefix":"pfx"}],"next_cursor":null,"has_more":false}`), &pg); err != nil {
		t.Fatalf("items envelope: %v", err)
	}
	if len(pg.Items) != 1 || pg.Items[0].ID != "a" || pg.Items[0].Prefix != "pfx" {
		t.Fatalf("items envelope: got %+v", pg.Items)
	}
	if pg.HasMore {
		t.Error("has_more:false must decode as false")
	}
}

// --- ADR-100: the write body -------------------------------------------------

func newUserKeysRealm(t *testing.T, url string) *Realm {
	t.Helper()
	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: url})
	return r
}

const userKeysRoute = "/tenants/t1/users/u1/user-api-keys"

// TestUserAPIKeys_CreateAlwaysStatesUncapped is the Go expression of ADR-100's
// central rule. `false` is exactly the value an omitempty-shaped tag would drop,
// and dropping it would put the pre-ADR-100 wire shape — a body with no
// authority statement — back on the wire from inside the SDK that exists to
// prevent it.
func TestUserAPIKeys_CreateAlwaysStatesUncapped(t *testing.T) {
	var gotBody map[string]any
	srv := authTestServer(t, map[string]http.HandlerFunc{
		userKeysRoute: func(w http.ResponseWriter, r *http.Request) {
			buf, _ := io.ReadAll(r.Body)
			_ = json.Unmarshal(buf, &gotBody)
			w.WriteHeader(http.StatusCreated)
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "k1"})
		},
	})
	defer srv.Close()

	_, err := newUserKeysRealm(t, srv.URL).UserAPIKeys.Create(ctxpkg.Background(), "t1", "u1",
		UserAPIKeyWrite{Label: "ci", Uncapped: Uncapped(false), PermissionsCap: []string{"a"}})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	raw, present := gotBody["uncapped"]
	if !present {
		t.Fatal("uncapped absent from the create body — that IS the shape ADR-100 makes illegal")
	}
	if raw != false {
		t.Errorf("uncapped = %v, want false", raw)
	}
}

// TestUserAPIKeys_NilUncappedTravelsAsNull pins the reason the field is a
// POINTER and carries no omitempty: "I did not say" has to be transmissible, so
// the server can answer 400 instead of the SDK quietly choosing false. A caller
// who forgets fails LOUDLY at the issuer, not silently at the wire.
func TestUserAPIKeys_NilUncappedTravelsAsNull(t *testing.T) {
	var raw []byte
	srv := authTestServer(t, map[string]http.HandlerFunc{
		userKeysRoute: func(w http.ResponseWriter, r *http.Request) {
			raw, _ = io.ReadAll(r.Body)
			w.WriteHeader(http.StatusCreated)
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "k1"})
		},
	})
	defer srv.Close()

	_, _ = newUserKeysRealm(t, srv.URL).UserAPIKeys.Create(ctxpkg.Background(), "t1", "u1",
		UserAPIKeyWrite{Label: "forgot"})

	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	v, present := decoded["uncapped"]
	if !present {
		t.Fatal("uncapped must be PRESENT and null, not omitted")
	}
	if v != nil {
		t.Errorf("uncapped = %v, want null", v)
	}
}

// TestUserAPIKeys_UpdateIsAPutOfTheSameShape pins D12's one-write-schema rule:
// Update's body is byte-identical to what Create would send for the same input,
// so the pair cannot drift into a PATCH.
func TestUserAPIKeys_UpdateIsAPutOfTheSameShape(t *testing.T) {
	var gotMethod, gotPath string
	var gotBody map[string]any
	srv := authTestServer(t, map[string]http.HandlerFunc{
		userKeysRoute + "/k9": func(w http.ResponseWriter, r *http.Request) {
			gotMethod, gotPath = r.Method, r.URL.Path
			buf, _ := io.ReadAll(r.Body)
			_ = json.Unmarshal(buf, &gotBody)
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "k9", "label": "ci"})
		},
	})
	defer srv.Close()

	body := UserAPIKeyWrite{Label: "ci", Uncapped: Uncapped(false), PermissionsCap: []string{"a"}}
	out, err := newUserKeysRealm(t, srv.URL).UserAPIKeys.Update(ctxpkg.Background(), "t1", "u1", "k9", body)
	if err != nil {
		t.Fatalf("Update: %v", err)
	}
	if gotMethod != "PUT" {
		t.Errorf("method = %q, want PUT", gotMethod)
	}
	if gotPath != userKeysRoute+"/k9" {
		t.Errorf("path = %q", gotPath)
	}
	if gotBody["uncapped"] != false || gotBody["label"] != "ci" {
		t.Errorf("body = %#v", gotBody)
	}
	if out.ID != "k9" {
		t.Errorf("ID = %q", out.ID)
	}
}

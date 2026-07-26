package realmid

import (
	ctxpkg "context"
	"errors"
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

	// The issuer's {items} envelope.
	got, err := decodeUserAPIKeyList([]byte(`{"items":[{"id":"a","prefix":"pfx","org_scope":"selected"}],"next_cursor":null}`))
	if err != nil || len(got) != 1 || got[0].ID != "a" || got[0].Prefix != "pfx" {
		t.Fatalf("items envelope: got %+v err=%v", got, err)
	}
	// A flat array, for resilience.
	got, err = decodeUserAPIKeyList([]byte(`[{"id":"b"}]`))
	if err != nil || len(got) != 1 || got[0].ID != "b" {
		t.Fatalf("flat array: got %+v err=%v", got, err)
	}
	// Anything else is an error rather than a silent empty list — an empty list
	// would read as "this user has no keys", which is a different and misleading
	// fact.
	if _, err = decodeUserAPIKeyList([]byte(`"nope"`)); err == nil {
		t.Error("an unexpected shape must error, not read as an empty list")
	}
}

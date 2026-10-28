package realmid

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"testing"
)

// SPEC14_10_actor / R86: ONE typed error for the SDK's local refusal and the server's
// 403 actor_required. Go: sentinel ErrActorRequired in RealmError.Cause, ErrCodeActorRequired,
// IsActorRequired(err).

func assertActorRequired(t *testing.T, what string, err error) {
	t.Helper()
	if err == nil {
		t.Errorf("%s: want actor_required, got nil", what)
		return
	}
	if !errors.Is(err, ErrActorRequired) {
		t.Errorf("%s: errors.Is(err, ErrActorRequired) = false; err = %v", what, err)
	}
	if !IsActorRequired(err) {
		t.Errorf("%s: IsActorRequired = false; err = %v", what, err)
	}
	var re *RealmError
	if !errors.As(err, &re) || re.Code != ErrCodeActorRequired {
		t.Errorf("%s: RealmError.Code = %v, want %q", what, re, ErrCodeActorRequired)
	}
	if !strings.Contains(err.Error(), "X-User-Token") {
		t.Errorf("%s: message lacks the X-User-Token hint: %v", what, err)
	}
}

func TestActorRequired_ServerCodeDecodedToTypedError(t *testing.T) {
	f := newFakeIssuer(t)
	f.on("/tenants/t1", func(w http.ResponseWriter, _ *http.Request, _ map[string]any) {
		jsonReply(w, 403, map[string]any{"error": map[string]any{"code": "actor_required", "message": "needs an actor"}})
	})
	_, err := f.realm(t, nil).Tenants.Get(context.Background(), "t1")
	assertActorRequired(t, "server 403", err)
	var re *RealmError
	if errors.As(err, &re) && re.HTTPStatus != 403 {
		t.Errorf("HTTPStatus = %d, want 403 kept", re.HTTPStatus)
	}
}

func TestActorRequired_LocalRefusalIsTheSameTypedErrorAndSendsNothing(t *testing.T) {
	f := escortFake(t)
	r := f.realm(t, nil)
	// no MeAuth, no WithUserToken: a bare platform call on an actor route (R61)
	_, err := r.Me.ListContacts(context.Background(), ListContactsRequest{}).Page(context.Background(), nil)
	assertActorRequired(t, "local refusal (Me)", err)
	if n := len(f.reqs("/me/contacts")); n != 0 {
		t.Errorf("local refusal still sent %d requests to /me/contacts", n)
	}
	err = drainSessions(context.Background(), r, "u1")
	assertActorRequired(t, "local refusal (sessions, id without token)", err)
}

func TestActorRequired_PredicateIsSafeAndSeesThroughWrapping(t *testing.T) {
	if IsActorRequired(nil) || IsActorRequired(errors.New("x")) || IsActorRequired(&RealmError{Code: ErrCodeBadRequest}) {
		t.Error("IsActorRequired true for an unrelated error")
	}
	if !IsActorRequired(fmt.Errorf("job failed: %w", &RealmError{Code: ErrCodeActorRequired, Cause: ErrActorRequired})) {
		t.Error("IsActorRequired false through %w wrapping")
	}
	if ErrCodeActorRequired != "actor_required" {
		t.Errorf("ErrCodeActorRequired = %q", ErrCodeActorRequired)
	}
}

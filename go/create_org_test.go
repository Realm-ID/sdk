package realmid

import (
	"context"
	"net/http"
	"testing"
)

// SPEC14_11_create_org (R67.1, R83): create-org is a no-actor call that takes the owner and
// returns it seated at role `owner`.
func TestCreateOrg_OwnerInlineNoActorAndReturnedSeatedAsOwner(t *testing.T) {
	f := newFakeIssuer(t)
	f.on("/platforms/"+testRealmID+"/tenants", func(w http.ResponseWriter, _ *http.Request, _ map[string]any) {
		jsonReply(w, 201, map[string]any{"id": "t9", "display_name": "Acme", "owner_user_id": "u9",
			"owner": map[string]any{"id": "u9", "email": "o@acme.test", "role": "owner"}})
	})
	got, err := f.realm(t, nil).Tenants.Create(context.Background(), TenantCreate{
		DisplayName: "Acme", Owner: &TenantOwner{Email: "o@acme.test"}})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	rs := f.reqs("/platforms/" + testRealmID + "/tenants")
	if len(rs) != 1 || rs[0].Auth != "Bearer ptok" || rs[0].UserToken != "" {
		t.Fatalf("create request: %+v (want platform bearer, no X-User-Token)", rs)
	}
	owner, _ := rs[0].Body["owner"].(map[string]any)
	if owner["email"] != "o@acme.test" {
		t.Errorf("owner not sent inline: %v", rs[0].Body)
	}
	if _, has := owner["role"]; has {
		t.Errorf("owner carries a role field; the issuer seats `owner` itself (R83): %v", owner)
	}
	if got.Owner == nil || got.Owner.ID != "u9" || got.Owner.Role != "owner" || got.OwnerUserID != "u9" {
		t.Errorf("returned tenant does not show the owner seated at role owner: %+v owner=%+v", got, got.Owner)
	}
}

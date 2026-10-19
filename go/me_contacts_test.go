package realmid

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
)

// GET /me/contacts (issuer spec 0.63.0, build spec Revision 8).
func TestR9_ListContactsPagesAndSendsUserToken(t *testing.T) {
	var queries []string
	var auths []string
	realm := newR9Realm(t, map[string]http.HandlerFunc{
		"/me/contacts": func(w http.ResponseWriter, r *http.Request) {
			queries = append(queries, r.URL.RawQuery)
			auths = append(auths, r.Header.Get("X-User-Token"))
			if r.URL.Query().Get("cursor") == "" {
				_ = json.NewEncoder(w).Encode(map[string]any{"items": []map[string]any{
					{"id": "c-1", "kind": "phone", "value": "+15550100", "verified": false, "tenant_id": "t-1"},
				}, "next_cursor": "n2", "total": 2})
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"items": []map[string]any{
				{"id": "c-2", "kind": "email", "value": "a@b.c", "verified": true, "tenant_id": "t-2"},
			}, "next_cursor": nil, "total": 2})
		},
	})
	var got []MeContact
	for c, err := range realm.Me.ListContacts(context.Background(), ListContactsRequest{MeAuth: MeAuth{UserToken: "ut"}, Limit: 1}).All(context.Background()) {
		if err != nil {
			t.Fatal(err)
		}
		got = append(got, c)
	}
	if len(got) != 2 || got[0].ID != "c-1" || got[0].Kind != "phone" || got[0].TenantID != "t-1" || got[0].Verified || !got[1].Verified {
		t.Fatalf("got=%+v", got)
	}
	if len(queries) != 2 || queries[0] != "limit=1" || queries[1] != "cursor=n2&limit=1" || auths[0] != "ut" {
		t.Errorf("queries=%v auths=%v", queries, auths)
	}
}

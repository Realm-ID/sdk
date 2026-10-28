package realmid

import (
	"context"
	"net/http"
	"testing"
)

func TestMe_SetPasswordRequestShapePerLane(t *testing.T) {
	var gotBody map[string]any
	var gotAuth, gotUT, gotMethod string
	srv := meServer(t, map[string]http.HandlerFunc{
		"/me/password": func(w http.ResponseWriter, r *http.Request) {
			gotMethod, gotAuth, gotUT = r.Method, r.Header.Get("Authorization"), r.Header.Get("X-User-Token")
			gotBody = decodeBody(t, r)
			_, _ = w.Write([]byte(`{"data":{"status":"updated","revoked_sids":[]}}`))
		},
	})
	defer srv.Close()
	r := newPWRealm(t, srv.URL)

	out, err := r.Me.SetPassword(context.Background(), SetPasswordRequest{MeAuth: MeAuth{UserToken: "ub"}, CurrentPassword: "old-old-old-1", NewPassword: "new-new-new-12"})
	if err != nil {
		t.Fatal(err)
	}
	if out.Status != "updated" || gotMethod != "PUT" || gotAuth != "Bearer ptok" || gotUT != "ub" ||
		gotBody["current_password"] != "old-old-old-1" || gotBody["new_password"] != "new-new-new-12" {
		t.Errorf("direct lane: %s auth=%q ut=%q body=%v", gotMethod, gotAuth, gotUT, gotBody)
	}

	if _, err := r.Me.SetPassword(context.Background(), SetPasswordRequest{MeAuth: MeAuth{UserToken: "ut"}, NewPassword: "new-new-new-12"}); err != nil {
		t.Fatal(err)
	}
	if gotAuth == "Bearer ub" || gotAuth == "" || gotUT != "ut" {
		t.Errorf("BFF lane: auth=%q ut=%q", gotAuth, gotUT)
	}
	if _, present := gotBody["current_password"]; present {
		t.Errorf("empty CurrentPassword must be omitted: %v", gotBody)
	}
}

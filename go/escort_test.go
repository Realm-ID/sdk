package realmid

import (
	"context"
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// SPEC14_10_actor (R60): platform token in Authorization, the person/key/SA token in X-User-Token.

func escortFake(t *testing.T) *fakeIssuer {
	f := newFakeIssuer(t)
	for _, p := range []string{"/me/contacts", "/auth/mfa/challenge", "/auth/sessions", "/echo"} {
		f.on(p, func(w http.ResponseWriter, _ *http.Request, _ map[string]any) {
			jsonReply(w, 200, map[string]any{"items": []any{}, "mfa_challenge_token": "c", "methods": []string{"totp"}, "sessions": []any{}})
		})
	}
	return f
}

func checkEscort(t *testing.T, f *fakeIssuer, path, wantUser string) {
	t.Helper()
	rs := f.reqs(path)
	if len(rs) == 0 {
		t.Errorf("%s: no request reached the issuer", path)
		return
	}
	if rs[0].Auth != "Bearer ptok" {
		t.Errorf("%s: Authorization = %q, want the platform token (R60)", path, rs[0].Auth)
	}
	if rs[0].UserToken != wantUser {
		t.Errorf("%s: X-User-Token = %q, want %q", path, rs[0].UserToken, wantUser)
	}
}

func TestEscort_MeCallSendsPlatformBearerAndUserTokenHeader(t *testing.T) {
	f := escortFake(t)
	r := f.realm(t, nil)
	it := r.Me.ListContacts(context.Background(), ListContactsRequest{MeAuth: MeAuth{UserToken: "utok"}})
	_, _ = it.Page(context.Background(), nil)
	checkEscort(t, f, "/me/contacts", "utok")
}

func TestEscort_ContextUserTokenRidesInHeaderOnTypedCalls(t *testing.T) {
	f := escortFake(t)
	r := f.realm(t, nil)
	ctx := WithUserToken(context.Background(), "utok2")
	_, _, _ = r.Auth.MintMFAChallenge(ctx, MFAChallengeRequest{OnBehalfOfIP: "203.0.113.9"})
	checkEscort(t, f, "/auth/mfa/challenge", "utok2")
}

func TestEscort_PassthroughCarriesRevocationTokenInHeaderNotBearer(t *testing.T) {
	f := escortFake(t)
	r := f.realm(t, nil)
	req := httptest.NewRequest("GET", "/echo", nil)
	resp, err := r.Do(context.Background(), req.Method, "/echo", nil, &PassthroughOptions{OnBehalfOfUserToken: "rev-link-token"})
	if err != nil {
		t.Fatalf("Do: %v", err)
	}
	_ = resp.Body.Close()
	checkEscort(t, f, "/echo", "rev-link-token")
}

func TestEscort_ListSessionsEscortForm(t *testing.T) {
	f := escortFake(t)
	r := f.realm(t, nil)
	ctx := WithUserToken(context.Background(), "utok3")
	_ = drainSessions(ctx, r, "u1")
	rs := f.reqs("/auth/sessions")
	if len(rs) == 0 || rs[0].Auth != "Bearer ptok" || rs[0].UserToken != "utok3" {
		t.Errorf("sessions request: %+v", rs)
	}
}

// R60 removes every mode that puts a user token in the bearer slot. Compile-level check by AST:
// no declaration (field, parameter, variable) in non-test source is named UserBearer, and
// MFAChallengeRequest has no AccessToken field.
func TestEscort_NoUserBearerAPIRemains(t *testing.T) {
	fset := token.NewFileSet()
	pkgs, err := parser.ParseDir(fset, ".", func(fi fs.FileInfo) bool { return !strings.HasSuffix(fi.Name(), "_test.go") }, 0)
	if err != nil {
		t.Fatal(err)
	}
	files := 0
	for _, p := range pkgs {
		for fn, f := range p.Files {
			files++
			ast.Inspect(f, func(n ast.Node) bool {
				switch x := n.(type) {
				case *ast.Field:
					for _, nm := range x.Names {
						if nm.Name == "UserBearer" || nm.Name == "userBearer" {
							t.Errorf("%s: field/param %s survives (R60)", fn, nm.Name)
						}
					}
				case *ast.TypeSpec:
					if st, ok := x.Type.(*ast.StructType); ok && x.Name.Name == "MFAChallengeRequest" {
						for _, fl := range st.Fields.List {
							for _, nm := range fl.Names {
								if nm.Name == "AccessToken" {
									t.Errorf("%s: MFAChallengeRequest.AccessToken survives (R60)", fn)
								}
							}
						}
					}
				}
				return true
			})
		}
	}
	if files < 50 {
		t.Fatalf("examined only %d source files; the scan is not looking at the package", files)
	}
}

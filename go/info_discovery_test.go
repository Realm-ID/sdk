package realmid

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func infoRealm(t *testing.T, row map[string]any) *Realm {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/auth/token", platformMintThen(userMintHandler("atok")))
	mux.HandleFunc("/auth/login", platformMintThen(userMintHandler("atok")))
	mux.HandleFunc("/platforms/mine", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"items": []any{row}})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	r, err := NewRealm(Config{SessionStore: NewMemorySessionStore(), RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL, Clock: func() time.Time { return time.Unix(1_800_000_000, 0) }})
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func TestInfo_RowWithoutAudienceIsADiscoveryError(t *testing.T) {
	for name, row := range map[string]map[string]any{
		"absent": {"id": testRealmID, "domain": "acme.test"},
		"null":   {"id": testRealmID, "audience": nil, "domain": "acme.test"},
		"empty":  {"id": testRealmID, "audience": "", "domain": "acme.test"},
	} {
		t.Run(name, func(t *testing.T) {
			got, err := infoRealm(t, row).info.Info(context.Background())
			if err == nil {
				t.Fatalf("a row without an audience must be an error, got %+v", got)
			}
		})
	}
}

func TestInfo_RowWithAudienceIsReturned(t *testing.T) {
	got, err := infoRealm(t, map[string]any{"id": testRealmID, "audience": "realmid:abc", "domain": "acme.test"}).info.Info(context.Background())
	if err != nil || got.Audience != "realmid:abc" {
		t.Fatalf("got %+v err %v", got, err)
	}
}

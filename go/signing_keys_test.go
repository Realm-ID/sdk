package realmid

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestSigningKeys_ListReadsKeyringAndPolicy(t *testing.T) {
	mux := http.NewServeMux()
	mintPlatformToken(mux)
	mux.HandleFunc("/platforms/"+testRealmID+"/signing-keys", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" {
			t.Errorf("method=%s", r.Method)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"keys": []any{
				map[string]any{"kid": "k2", "created_at": 200, "active_until": 900, "retire_at": 1200, "is_current": true},
				map[string]any{"kid": "k1", "created_at": 100, "active_until": 200, "retire_at": 500, "is_current": false},
			},
			"rotation": map[string]any{"mode": "auto", "interval": "1w", "next_rotation_at": 900},
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	out, err := r.SigningKeys.List(context.Background())
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(out.Keys) != 2 {
		t.Fatalf("keys=%d", len(out.Keys))
	}
	if !out.Keys[0].IsCurrent {
		t.Errorf("first key should be current")
	}
	if out.Rotation.Mode != "auto" || out.Rotation.Interval != "1w" || out.Rotation.NextRotationAt != 900 {
		t.Errorf("rotation=%+v", out.Rotation)
	}
}

func TestSigningKeys_RotatePostsAndReturnsKIDs(t *testing.T) {
	mux := http.NewServeMux()
	mintPlatformToken(mux)
	mux.HandleFunc("/platforms/"+testRealmID+"/signing-keys/rotate", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" {
			t.Errorf("method=%s", r.Method)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"kid": "k3", "retired_kids": []string{"k1"}})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	out, err := r.SigningKeys.Rotate(context.Background())
	if err != nil {
		t.Fatalf("rotate: %v", err)
	}
	if out.KID != "k3" {
		t.Errorf("kid=%q", out.KID)
	}
	if len(out.RetiredKIDs) != 1 || out.RetiredKIDs[0] != "k1" {
		t.Errorf("retired=%v", out.RetiredKIDs)
	}
}

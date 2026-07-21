package realmid

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestConfig_GetReturnsRealmIDAndLooseMap(t *testing.T) {
	mux := http.NewServeMux()
	mintPlatformToken(mux)
	mux.HandleFunc("/platforms/"+testRealmID+"/config", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" {
			t.Errorf("method=%s", r.Method)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"id": testRealmID,
			"config": map[string]any{
				"idle_ttl_seconds":               900,
				"mfa_policy":                     "enforced",
				"require_bff_login":              true,
				"origin_enforcement":             "",
				"access_token_custom_claim_keys": []string{},
				"refresh_absolute_expiry": map[string]any{
					"mode":               "rolling",
					"daily_cutoff_local": "",
					"timezone":           "",
					"applies_to_service": false,
				},
			},
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	out, err := r.Config.Get(context.Background())
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if out.ID != testRealmID {
		t.Errorf("id=%q", out.ID)
	}
	if len(out.Config) != 6 {
		t.Errorf("config keys=%d, want 6 (%v)", len(out.Config), out.Config)
	}
	if v, ok := out.Config["idle_ttl_seconds"].(float64); !ok || v != 900 {
		t.Errorf("idle_ttl_seconds=%#v", out.Config["idle_ttl_seconds"])
	}
	if out.Config["mfa_policy"] != "enforced" {
		t.Errorf("mfa_policy=%#v", out.Config["mfa_policy"])
	}
	if out.Config["require_bff_login"] != true {
		t.Errorf("require_bff_login=%#v", out.Config["require_bff_login"])
	}
	// Zero values are meaningful ("unset") and must survive as keys.
	v, ok := out.Config["origin_enforcement"]
	if !ok || v != "" {
		t.Errorf("origin_enforcement present=%v value=%#v", ok, v)
	}
	claims, ok := out.Config["access_token_custom_claim_keys"].([]any)
	if !ok || len(claims) != 0 {
		t.Errorf("access_token_custom_claim_keys=%#v", out.Config["access_token_custom_claim_keys"])
	}
	rae, ok := out.Config["refresh_absolute_expiry"].(map[string]any)
	if !ok || rae["mode"] != "rolling" {
		t.Errorf("refresh_absolute_expiry=%#v", out.Config["refresh_absolute_expiry"])
	}
}

func TestConfig_GetEmptyBodyYieldsNonNilMap(t *testing.T) {
	mux := http.NewServeMux()
	mintPlatformToken(mux)
	mux.HandleFunc("/platforms/"+testRealmID+"/config", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"id": testRealmID})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	out, err := r.Config.Get(context.Background())
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if out.Config == nil {
		t.Fatalf("Config should be non-nil")
	}
	if len(out.Config) != 0 {
		t.Errorf("config=%v", out.Config)
	}
}

func TestStats_GetDecodesRollup(t *testing.T) {
	mux := http.NewServeMux()
	mintPlatformToken(mux)
	mux.HandleFunc("/platforms/"+testRealmID+"/stats", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" {
			t.Errorf("method=%s", r.Method)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"platform_id":  testRealmID,
			"generated_at": 1783400000,
			"orgs_count":   7,
			"users_count":  40,
			"sessions_24h": 12,
			"mfa_coverage": map[string]any{
				"covered_users":  8,
				"eligible_users": 40,
				"percent":        20.0,
			},
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	out, err := r.Stats.Get(context.Background())
	if err != nil {
		t.Fatalf("stats: %v", err)
	}
	if out.PlatformID != testRealmID {
		t.Errorf("platform_id=%q", out.PlatformID)
	}
	if out.GeneratedAt != 1783400000 {
		t.Errorf("generated_at=%d", out.GeneratedAt)
	}
	if out.OrgsCount != 7 || out.UsersCount != 40 || out.Sessions24h != 12 {
		t.Errorf("counts=%+v", out)
	}
	if out.MFACoverage.CoveredUsers != 8 || out.MFACoverage.EligibleUsers != 40 {
		t.Errorf("coverage=%+v", out.MFACoverage)
	}
	if out.MFACoverage.Percent == nil || *out.MFACoverage.Percent != 20.0 {
		t.Errorf("percent=%#v", out.MFACoverage.Percent)
	}
}

func TestStats_NullPercentDecodesAsNilNotZero(t *testing.T) {
	mux := http.NewServeMux()
	mintPlatformToken(mux)
	mux.HandleFunc("/platforms/"+testRealmID+"/stats", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"platform_id":"` + testRealmID + `","generated_at":1,"orgs_count":0,"users_count":0,"sessions_24h":0,"mfa_coverage":{"covered_users":0,"eligible_users":0,"percent":null}}`))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
	out, err := r.Stats.Get(context.Background())
	if err != nil {
		t.Fatalf("stats: %v", err)
	}
	if out.MFACoverage.Percent != nil {
		t.Errorf("percent should be nil for an empty eligible population, got %v", *out.MFACoverage.Percent)
	}
}

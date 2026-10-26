package realmid

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

// platform_token_replay_test.go — SPEC §4.0.1 "Replayed-assertion retry".
// A workload login answered 409 assertion_replayed is retried with a freshly
// fetched credential after 1 s then 2 s, three attempts in all.

// seqCred is a workload CredentialSource whose every Fetch returns a new
// token ("wl-1", "wl-2", ...), counting the fetches.
type seqCred struct{ n atomic.Int32 }

func (s *seqCred) Fetch(_ context.Context) (Credential, error) {
	n := s.n.Add(1)
	return Credential{GrantType: grantTokenExchange, SubjectToken: "wl-" + string(rune('0'+n))}, nil
}

// replayServer answers 409/<code> to the first `replays` logins and a good
// session afterwards. It records the subject_token of each attempt.
func replayServer(t *testing.T, status int, code string, replays int32, seen *[]string) *httptest.Server {
	t.Helper()
	var calls atomic.Int32
	mux := http.NewServeMux()
	mux.HandleFunc("/auth/login", func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if s, ok := body["subject_token"].(string); ok {
			*seen = append(*seen, s)
		} else if k, ok := body["api_key"].(string); ok {
			*seen = append(*seen, k)
		}
		if calls.Add(1) <= replays {
			w.WriteHeader(status)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"error": map[string]any{"code": code, "message": "assertion already used; fetch a fresh one and retry"},
			})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"status": "ok", "subject_type": "platform", "access_token": "at", "expires_in": 60,
		})
	})
	return httptest.NewServer(mux)
}

func replayRealm(t *testing.T, srv *httptest.Server, cfg Config) (*Realm, *[]time.Duration) {
	t.Helper()
	cfg.SessionStore = NewMemorySessionStore()
	cfg.RealmID = testRealmID
	cfg.BaseURL = srv.URL
	r, err := NewRealm(cfg)
	if err != nil {
		t.Fatalf("NewRealm: %v", err)
	}
	var waits []time.Duration
	r.platformToken.sleep = func(_ context.Context, d time.Duration) error {
		waits = append(waits, d)
		return nil
	}
	return r, &waits
}

func TestSessionReplay_RetriesWithFreshCredential(t *testing.T) {
	var seen []string
	srv := replayServer(t, 409, "assertion_replayed", 2, &seen)
	defer srv.Close()
	cred := &seqCred{}
	r, waits := replayRealm(t, srv, Config{Credential: cred})

	tok, err := r.platformToken.get(context.Background())
	if err != nil || tok != "at" {
		t.Fatalf("get: tok=%q err=%v", tok, err)
	}
	if cred.n.Load() != 3 {
		t.Errorf("credential fetched %d times, want 3 (one per attempt)", cred.n.Load())
	}
	if len(seen) != 3 || seen[0] == seen[1] || seen[1] == seen[2] {
		t.Errorf("each attempt must carry a NEW credential, got %v", seen)
	}
	if len(*waits) != 2 || (*waits)[0] != time.Second || (*waits)[1] != 2*time.Second {
		t.Errorf("backoff: got %v want [1s 2s]", *waits)
	}
}

func TestSessionReplay_ExhaustedReturnsLastErrorUnchanged(t *testing.T) {
	var seen []string
	srv := replayServer(t, 409, "assertion_replayed", 99, &seen)
	defer srv.Close()
	cred := &seqCred{}
	r, waits := replayRealm(t, srv, Config{Credential: cred})

	_, err := r.platformToken.get(context.Background())
	if !IsCode(err, ErrCodeAssertionReplayed) {
		t.Fatalf("want assertion_replayed, got %v", err)
	}
	re, _ := err.(*RealmError)
	if re == nil || re.HTTPStatus != 409 {
		t.Errorf("error must be the server's 409 unchanged, got %#v", err)
	}
	if len(seen) != 3 || cred.n.Load() != 3 {
		t.Errorf("max 3 attempts: server saw %d, fetched %d", len(seen), cred.n.Load())
	}
	if len(*waits) != 2 {
		t.Errorf("waits: got %v want two", *waits)
	}
}

func TestSessionReplay_StaticAPIKeyNeverRetried(t *testing.T) {
	var seen []string
	srv := replayServer(t, 409, "assertion_replayed", 99, &seen)
	defer srv.Close()
	r, waits := replayRealm(t, srv, Config{APIKey: "rk_live_test"})

	_, err := r.platformToken.get(context.Background())
	if err == nil {
		t.Fatal("expected error")
	}
	if len(seen) != 1 || len(*waits) != 0 {
		t.Errorf("api-key login must not retry: attempts=%d waits=%v", len(seen), *waits)
	}
}

func TestSessionReplay_OtherCodeAndStatusNeverRetried(t *testing.T) {
	for _, c := range []struct {
		name   string
		status int
		code   string
	}{
		{"other 409 code", 409, "conflict"},
		{"401 with the replay code", 401, "assertion_replayed"},
		{"plain 401", 401, "unauthorized"},
	} {
		t.Run(c.name, func(t *testing.T) {
			var seen []string
			srv := replayServer(t, c.status, c.code, 99, &seen)
			defer srv.Close()
			r, waits := replayRealm(t, srv, Config{Credential: &seqCred{}})
			if _, err := r.platformToken.get(context.Background()); err == nil {
				t.Fatal("expected error")
			}
			if len(seen) != 1 || len(*waits) != 0 {
				t.Errorf("must not retry: attempts=%d waits=%v", len(seen), *waits)
			}
		})
	}
}

// A cancelled context during the backoff returns promptly with the context's
// error — through the REAL sleep, so this also proves the default honours ctx.
func TestSessionReplay_CancelDuringBackoffReturnsPromptly(t *testing.T) {
	var seen []string
	srv := replayServer(t, 409, "assertion_replayed", 99, &seen)
	defer srv.Close()
	cfg := Config{Credential: &seqCred{}, SessionStore: NewMemorySessionStore(), RealmID: testRealmID, BaseURL: srv.URL}
	r, err := NewRealm(cfg)
	if err != nil {
		t.Fatalf("NewRealm: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	time.AfterFunc(50*time.Millisecond, cancel)

	start := time.Now()
	_, err = r.platformToken.get(ctx)
	if err == nil {
		t.Fatal("expected error")
	}
	if el := time.Since(start); el > 800*time.Millisecond {
		t.Errorf("took %v; a 1s backoff must be abandoned on cancel", el)
	}
	if ctx.Err() == nil || len(seen) != 1 {
		t.Errorf("want exactly 1 attempt before cancel, got %d", len(seen))
	}
}

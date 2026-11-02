package deviceclient

// RED tests for SPEC §15.7. They run against signature-only stubs and fail on missing behaviour.

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

type bff struct {
	srv   *httptest.Server
	mu    sync.Mutex
	polls []time.Time
	forms []map[string]string
	poll  func(n int, w http.ResponseWriter)
}

func newBFF(t *testing.T, poll func(n int, w http.ResponseWriter)) *bff {
	b := &bff{poll: poll}
	mux := http.NewServeMux()
	mux.HandleFunc("/device/start", func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		b.mu.Lock()
		b.forms = append(b.forms, map[string]string{"client_id": r.Form.Get("client_id"), "device_name": r.Form.Get("device_name"), "subject_hint": r.Form.Get("subject_hint")})
		b.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"device_code":"dc","user_code":"ABCD-EFGH","verification_uri":"https://p.example/device","verification_uri_complete":"https://p.example/device?code=ABCD-EFGH","expires_in":600,"interval":5}`))
	})
	mux.HandleFunc("/device/token", func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		b.mu.Lock()
		b.polls = append(b.polls, time.Now())
		b.forms = append(b.forms, map[string]string{"grant_type": r.Form.Get("grant_type"), "device_code": r.Form.Get("device_code")})
		n := len(b.polls)
		b.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		b.poll(n, w)
	})
	b.srv = httptest.NewServer(mux)
	t.Cleanup(b.srv.Close)
	return b
}

func (b *bff) cfg() Config {
	return Config{StartURL: b.srv.URL + "/device/start", TokenURL: b.srv.URL + "/device/token", ClientID: "traide-cli", DeviceName: "build-box", SubjectHint: "sync-bot"}
}

func rfcErr(w http.ResponseWriter, status int, code string) {
	w.WriteHeader(status)
	_, _ = w.Write([]byte(`{"error":"` + code + `"}`))
}

func TestStart_SendsFormAndParsesRFC8628Answer(t *testing.T) {
	b := newBFF(t, func(int, http.ResponseWriter) {})
	a, err := Start(context.Background(), b.cfg())
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if a.DeviceCode != "dc" || a.UserCode != "ABCD-EFGH" || a.VerificationURI != "https://p.example/device" ||
		a.VerificationURIComplete != "https://p.example/device?code=ABCD-EFGH" || a.ExpiresIn != 600 || a.Interval != 5 {
		t.Errorf("Authorization = %+v", a)
	}
	f := b.forms[0]
	if f["client_id"] != "traide-cli" || f["device_name"] != "build-box" || f["subject_hint"] != "sync-bot" {
		t.Errorf("start form = %v", f)
	}
}

func TestStart_NonSuccessIsATypedError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		rfcErr(w, 400, "invalid_client_id")
	}))
	defer srv.Close()
	_, err := Start(context.Background(), Config{StartURL: srv.URL, TokenURL: srv.URL})
	var e *Error
	if !errors.As(err, &e) || e.Code != "invalid_client_id" || e.Status != 400 {
		t.Errorf("err = %v, want *Error{invalid_client_id, 400}", err)
	}
}

func TestPoll_PendingThenSuccessReturnsRawBody(t *testing.T) {
	b := newBFF(t, func(n int, w http.ResponseWriter) {
		if n < 2 {
			rfcErr(w, 400, "authorization_pending")
			return
		}
		_, _ = w.Write([]byte(`{"access_token":"at","token_type":"Bearer","expires_in":900}`))
	})
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	raw, err := Poll(ctx, b.cfg(), &Authorization{DeviceCode: "dc", ExpiresIn: 600, Interval: 1})
	if err != nil {
		t.Fatalf("Poll: %v", err)
	}
	var m map[string]any
	if json.Unmarshal(raw, &m) != nil || m["access_token"] != "at" {
		t.Errorf("raw body = %s", raw)
	}
	last := b.forms[len(b.forms)-1]
	if last["grant_type"] != "urn:ietf:params:oauth:grant-type:device_code" || last["device_code"] != "dc" {
		t.Errorf("poll form = %v", last)
	}
}

func TestPoll_SlowDownAddsFiveSecondsAndKeepsTheLargerInterval(t *testing.T) {
	b := newBFF(t, func(n int, w http.ResponseWriter) {
		switch n {
		case 1:
			rfcErr(w, 400, "slow_down")
		case 2:
			rfcErr(w, 400, "authorization_pending")
		default:
			_, _ = w.Write([]byte(`{"access_token":"at"}`))
		}
	})
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	if _, err := Poll(ctx, b.cfg(), &Authorization{DeviceCode: "dc", ExpiresIn: 600, Interval: 1}); err != nil {
		t.Fatalf("Poll: %v", err)
	}
	if len(b.polls) != 3 {
		t.Fatalf("polls = %d, want 3", len(b.polls))
	}
	if gap := b.polls[1].Sub(b.polls[0]); gap < 5900*time.Millisecond {
		t.Errorf("gap after slow_down = %v, want >= 6s (interval 1s + 5s)", gap)
	}
	if gap := b.polls[2].Sub(b.polls[1]); gap < 5900*time.Millisecond {
		t.Errorf("gap after the next pending = %v, want the larger interval (>= 6s) kept", gap)
	}
}

func TestPoll_TerminalCodes(t *testing.T) {
	for code, want := range map[string]error{"access_denied": ErrAccessDenied, "expired_token": ErrExpiredToken} {
		t.Run(code, func(t *testing.T) {
			b := newBFF(t, func(_ int, w http.ResponseWriter) { rfcErr(w, 400, code) })
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			_, err := Poll(ctx, b.cfg(), &Authorization{DeviceCode: "dc", ExpiresIn: 600, Interval: 1})
			if !errors.Is(err, want) {
				t.Errorf("err = %v, want %v", err, want)
			}
		})
	}
}

func TestPoll_AnyOtherCodeIsTheRealReason(t *testing.T) {
	b := newBFF(t, func(_ int, w http.ResponseWriter) { rfcErr(w, 403, "user_suspended") })
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	_, err := Poll(ctx, b.cfg(), &Authorization{DeviceCode: "dc", ExpiresIn: 600, Interval: 1})
	var e *Error
	if !errors.As(err, &e) || e.Code != "user_suspended" || e.Status != 403 {
		t.Errorf("err = %v, want *Error{user_suspended, 403} (R-CLI2)", err)
	}
}

func TestPoll_ContextCancelReturnsCtxErr(t *testing.T) {
	b := newBFF(t, func(_ int, w http.ResponseWriter) { rfcErr(w, 400, "authorization_pending") })
	ctx, cancel := context.WithCancel(context.Background())
	go func() { time.Sleep(300 * time.Millisecond); cancel() }()
	done := make(chan error, 1)
	go func() {
		_, err := Poll(ctx, b.cfg(), &Authorization{DeviceCode: "dc", ExpiresIn: 600, Interval: 30})
		done <- err
	}()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Errorf("err = %v, want context.Canceled", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Poll ignored ctx cancellation while waiting out the interval")
	}
}

func TestPoll_PastExpiresInReturnsExpiredTokenWithoutAnotherRequest(t *testing.T) {
	b := newBFF(t, func(_ int, w http.ResponseWriter) { rfcErr(w, 400, "authorization_pending") })
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	_, err := Poll(ctx, b.cfg(), &Authorization{DeviceCode: "dc", ExpiresIn: 1, Interval: 1})
	if !errors.Is(err, ErrExpiredToken) {
		t.Errorf("err = %v, want ErrExpiredToken at the ExpiresIn deadline", err)
	}
	if n := len(b.polls); n > 2 {
		t.Errorf("%d polls for a 1s lifetime at a 1s interval", n)
	}
}

// Guard (passes against the stub too; it protects the finished package): standard library only.
func TestDeviceClientAddsNoDependency(t *testing.T) {
	mod, err := os.ReadFile("../go.mod")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(mod), "require") {
		t.Errorf("go/go.mod gained a require; deviceclient must be standard library only:\n%s", mod)
	}
	files, _ := filepath.Glob("*.go")
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		src, _ := os.ReadFile(f)
		if strings.Contains(string(src), `"github.com/Realm-ID/sdk/go"`) {
			t.Errorf("%s imports the root realmid package", f)
		}
	}
	_ = http.StatusOK
}

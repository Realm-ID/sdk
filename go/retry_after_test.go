package realmid

import (
	"context"
	"errors"
	"net/http"
	"testing"
	"time"
)

// SPEC §3: RealmError.RetryAfter carries the server's Retry-After on any
// non-2xx response (delta-seconds or HTTP-date); 0 = absent or unparseable.
func TestRealmError_RetryAfter(t *testing.T) {
	future := time.Now().Add(90 * time.Second).UTC().Format(http.TimeFormat)
	cases := []struct {
		name   string
		status int
		header string
		min    time.Duration
		max    time.Duration
	}{
		{"429 delta seconds", 429, "120", 120 * time.Second, 120 * time.Second},
		{"503 delta seconds", 503, "7", 7 * time.Second, 7 * time.Second},
		{"absent", 429, "", 0, 0},
		{"garbage", 429, "soon", 0, 0},
		{"negative", 429, "-5", 0, 0},
		{"http-date", 429, future, 80 * time.Second, 91 * time.Second},
		{"http-date in the past", 429, "Mon, 02 Jan 2006 15:04:05 GMT", 0, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv := authTestServer(t, map[string]http.HandlerFunc{
				"/auth/otp/send-login": func(w http.ResponseWriter, r *http.Request) {
					if tc.header != "" {
						w.Header().Set("Retry-After", tc.header)
					}
					w.WriteHeader(tc.status)
					_, _ = w.Write([]byte(`{"error":"slow down","code":"phone_otp_rate_limited"}`))
				},
			})
			defer srv.Close()
			r, _ := NewRealm(Config{SessionStore: NewMemorySessionStore(), RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
			_, err := r.Auth.SendLoginCode(context.Background(), SendLoginCodeRequest{Identifier: "+919999000011", DeliveryMode: DeliveryModeSMS})
			var re *RealmError
			if !errors.As(err, &re) {
				t.Fatalf("err = %v, want *RealmError", err)
			}
			if re.HTTPStatus != tc.status {
				t.Fatalf("status = %d, want %d", re.HTTPStatus, tc.status)
			}
			if re.RetryAfter < tc.min || re.RetryAfter > tc.max {
				t.Errorf("RetryAfter = %v, want in [%v, %v]", re.RetryAfter, tc.min, tc.max)
			}
		})
	}
}

// Example: a minimal net/http server using realm.Middleware.
//
//	go run ./examples/server
//
// The middleware:
//   - exempts /health
//   - handles POST /login, /logout, /token, /mfa/verify
//   - verifies Bearer tokens on every other route and attaches Claims
//
// Set REALM_ID and REALM_API_KEY before running. BASE_URL defaults to
// the production issuer.
package main

import (
	"encoding/json"
	"log"
	"log/slog"
	"net/http"
	"os"

	realmid "github.com/Realm-ID/sdk/go"
)

func main() {
	realm, err := realmid.NewRealm(realmid.Config{
		RealmID: os.Getenv("REALM_ID"),
		APIKey:  os.Getenv("REALM_API_KEY"),
		BaseURL: envOr("BASE_URL", realmid.DefaultBaseURL),
		Logger:  slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo})),
	})
	if err != nil {
		log.Fatalf("realmid: %v", err)
	}

	mux := http.NewServeMux()

	// Public health route — exempted from auth by middleware.
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})

	// Protected route — pulls verified claims off the request context.
	mux.HandleFunc("/me", func(w http.ResponseWriter, r *http.Request) {
		claims, ok := realmid.ClaimsFrom(r.Context())
		if !ok {
			http.Error(w, "no claims", http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"sub":       claims.Subject,
			"tenant_id": claims.TenantID,
			"role":      claims.Role,
		})
	})

	mw := realm.Middleware(realmid.MiddlewareOptions{
		ExemptPaths:       []string{"/health"},
		MFAProtectedPaths: []string{"/admin/*"},
		CookieSecure:      false, // local dev — flip to true behind TLS
	})

	addr := envOr("ADDR", ":3000")
	log.Printf("realmid example listening on %s", addr)
	if err := http.ListenAndServe(addr, mw(mux)); err != nil {
		log.Fatal(err)
	}
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

// Minimal example: verify a RealmID access token from the command line and
// print the claims as JSON.
//
// Usage:
//
//	go run . \
//	    -base-url https://auth.realmid.dev \
//	    -audience your-partner-audience \
//	    -token <jwt>
package main

import (
	"encoding/json"
	"errors"
	"flag"
	"os"

	realmid "github.com/Realm-ID/sdk/go"
)

func main() {
	baseURL := flag.String("base-url", "", "RealmID issuer base URL, e.g. https://auth.realmid.dev")
	audience := flag.String("audience", "", "Expected aud claim, e.g. your partner audience")
	token := flag.String("token", "", "JWT access token to verify")
	flag.Parse()

	if *baseURL == "" || *audience == "" || *token == "" {
		_, _ = os.Stderr.WriteString("usage: go run . -base-url <url> -audience <aud> -token <jwt>\n")
		os.Exit(2)
	}

	v, err := realmid.NewVerifier(realmid.Config{
		BaseURL:  *baseURL,
		Audience: *audience,
	})
	if err != nil {
		_, _ = os.Stderr.WriteString("config: " + err.Error() + "\n")
		os.Exit(2)
	}

	claims, err := v.Verify(*token)
	if err != nil {
		var verr *realmid.Error
		if errors.As(err, &verr) {
			_, _ = os.Stderr.WriteString("verify failed: " + string(verr.Code) + " — " + verr.Message + "\n")
			os.Exit(1)
		}
		_, _ = os.Stderr.WriteString("verify failed: " + err.Error() + "\n")
		os.Exit(1)
	}

	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	_ = enc.Encode(claims)
}

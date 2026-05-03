// Example: list platforms via the admin aggregates surface (ADR-048,
// SPEC §7.5).
//
// Pass realm-id, api-key, and (optionally) base-url as flags:
//
//	go run ./examples/admin \
//	    -realm-id=… -api-key=… -base-url=https://auth.realmid.dev
//
// The realm/api-key combo MUST belong to the base realm — the server
// gates these endpoints on base-realm staff. The SDK forwards the
// platform-token bearer; the API answers 403 if the caller doesn't
// hold base-realm staff.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"io"
	"os"

	realmid "github.com/Realm-ID/sdk/go"
)

func main() {
	var (
		realmID = flag.String("realm-id", "", "base-realm id")
		apiKey  = flag.String("api-key", "", "base-realm API key")
		baseURL = flag.String("base-url", realmid.DefaultBaseURL, "issuer host")
	)
	flag.Parse()

	if *realmID == "" || *apiKey == "" {
		die("-realm-id and -api-key are required")
	}

	realm, err := realmid.NewRealm(realmid.Config{
		RealmID: *realmID,
		APIKey:  *apiKey,
		BaseURL: *baseURL,
	})
	if err != nil {
		die("realmid: " + err.Error())
	}

	ctx := context.Background()
	resp, err := realm.Admin.ListPlatforms(ctx, realmid.ListPlatformsParams{
		Limit: 25,
		Sort:  "created_desc",
	})
	if err != nil {
		die("ListPlatforms: " + err.Error())
	}

	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	if err := enc.Encode(map[string]any{
		"total":       resp.Total,
		"items":       resp.Items,
		"next_cursor": resp.NextCursor,
	}); err != nil {
		die(err.Error())
	}
}

func die(msg string) {
	_, _ = io.WriteString(os.Stderr, msg+"\n")
	os.Exit(1)
}

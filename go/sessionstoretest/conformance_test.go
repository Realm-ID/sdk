package sessionstoretest_test

import (
	"testing"

	realmid "github.com/Realm-ID/sdk/go"
	"github.com/Realm-ID/sdk/go/sessionstoretest"
)

// The in-memory store must pass the same suite a partner runs on their Redis store.
func TestMemorySessionStorePassesConformance(t *testing.T) {
	sessionstoretest.Run(t, func() realmid.SessionStateStore { return realmid.NewMemorySessionStore() })
}

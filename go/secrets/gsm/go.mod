module github.com/Realm-ID/sdk/go/secrets/gsm

go 1.23

require github.com/Realm-ID/sdk/go v0.70.0

// Local development resolves the core from the monorepo. Consumers ignore a dependency's
// replace, so a tagged release resolves the core from the module proxy.
replace github.com/Realm-ID/sdk/go => ../..

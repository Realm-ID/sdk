package realmid

import (
	"io"
	"log/slog"
)

// noopLogger returns a slog logger that discards all output. Used as the
// default when the partner does not supply one (SPEC §9).
func noopLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// redactCredential truncates a bearer-shaped string to its first 6
// characters, suffixed with `…`. Returns "<empty>" for empty input so
// log readers can still distinguish "no credential" from "redacted".
func redactCredential(value string) string {
	if value == "" {
		return "<empty>"
	}
	if len(value) <= 6 {
		return value + "…"
	}
	return value[:6] + "…"
}

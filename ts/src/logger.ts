/**
 * Structured logger interface — SPEC §9.
 *
 * A minimal, no-dependency contract that `console`, `pino`, `bunyan`, and
 * any other modern Node logger satisfies out of the box. The SDK never
 * logs raw credentials; helpers in this module redact bearer-shaped
 * strings to their first 6 characters.
 */

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

/** Default no-op logger used when the partner does not supply one. */
export const NOOP_LOGGER: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

/**
 * Truncate a credential to the first 6 chars, suffixed with `…`. Returns
 * the literal string `"<empty>"` for empty input so callers can still
 * tell apart "no credential" from "credential redacted".
 */
export function redactCredential(value: string | undefined | null): string {
  if (!value) return "<empty>";
  if (value.length <= 6) return value + "…";
  return value.slice(0, 6) + "…";
}

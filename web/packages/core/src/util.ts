/**
 * Resolve a numeric expiresIn (seconds from now) from either an explicit
 * `expiresIn` or an `expiresAt` (ISO string, ms epoch, or seconds epoch).
 * Returns undefined if neither is usable.
 */
export function resolveExpiresIn(
  expiresIn: number | undefined,
  expiresAt: string | number | undefined,
  now: number = Date.now(),
): number | undefined {
  if (typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0) {
    return expiresIn;
  }
  const at = parseExpiresAt(expiresAt);
  if (at === undefined) return undefined;
  const seconds = Math.max(0, Math.floor((at - now) / 1000));
  return seconds;
}

/** Parse an `expiresAt` of any flavour to ms-epoch. */
export function parseExpiresAt(at: string | number | undefined): number | undefined {
  if (at === undefined || at === null) return undefined;
  if (typeof at === "number" && Number.isFinite(at)) {
    // Heuristic: <1e12 → seconds epoch; otherwise ms.
    return at < 1e12 ? at * 1000 : at;
  }
  if (typeof at === "string") {
    const parsed = Date.parse(at);
    if (!Number.isNaN(parsed)) return parsed;
    const num = Number(at);
    if (Number.isFinite(num)) return parseExpiresAt(num);
  }
  return undefined;
}

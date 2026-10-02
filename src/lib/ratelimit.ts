const hits = new Map<number, { n: number; reset: number }>();

/** Per-user fixed-window rate limit. Returns true if allowed, false if over. */
export function rateLimit(userId: number, perMin: number): boolean {
  const now = Date.now();
  const w = hits.get(userId);
  if (!w || w.reset < now) {
    hits.set(userId, { n: 1, reset: now + 60_000 });
    return true;
  }
  w.n++;
  return w.n <= perMin;
}

import type { DiagnoseRow as DiagRow } from '../contracts/index.js';

/** Map a failed delivery to a concrete, human-readable cause an agent can relay. */
export function classify(r: DiagRow): { cause: string; plain: string } {
  const e = (r.error ?? '').toLowerCase();
  if (e.includes('ssrf')) {
    return { cause: 'ssrf_blocked', plain: 'blocked by SSRF guard (private/reserved IP destination)' };
  }
  if (e.includes('timed out') || e.includes('timeout') || e.includes('connect')) {
    return { cause: 'timeout', plain: 'connection timed out — destination unreachable or slow' };
  }
  if (e.includes('dns') || e.includes('resolve')) {
    return { cause: 'dns', plain: "DNS resolution failed — destination hostname doesn't resolve" };
  }
  const s = r.response_status ?? 0;
  if (s >= 500) return { cause: 'http_5xx', plain: 'destination returned 5xx (server error at the destination)' };
  if (s >= 400) return { cause: 'http_4xx', plain: 'destination returned 4xx (client error — check the URL/auth)' };
  if (s === 0) return { cause: 'no_response', plain: 'no response received — connection failed' };
  return { cause: 'unknown', plain: 'delivery failed for an unclassified reason' };
}

/** Build the structured diagnosis object. Pure function over delivery rows. */
export function diagnose(rows: DiagRow[], windowLabel: string) {
  const total = rows.length;
  const successCount = rows.filter((r) => r.status === 'success').length;
  const failures = rows.filter((r) => r.status === 'failed' || r.status === 'retrying');

  const byCause = new Map<string, { plain: string; n: number }>();
  const byDest = new Map<string, number>();
  for (const r of failures) {
    const c = classify(r);
    const cur = byCause.get(c.cause) ?? { plain: c.plain, n: 0 };
    cur.n++;
    byCause.set(c.cause, cur);
    byDest.set(r.destination_url, (byDest.get(r.destination_url) ?? 0) + 1);
  }

  const failures_by_cause = [...byCause.entries()]
    .map(([cause, v]) => ({ cause, plain_language: v.plain, affected_count: v.n }))
    .sort((a, b) => b.affected_count - a.affected_count);

  const top_failing_destinations = [...byDest.entries()]
    .map(([url, count]) => ({ url, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  return {
    window: windowLabel,
    total,
    success_count: successCount,
    success_rate: total ? Math.round((successCount / total) * 100) / 100 : null,
    failure_count: failures.length,
    failures_by_cause,
    top_failing_destinations,
    primary_diagnosis: failures_by_cause[0]
      ? {
          cause: failures_by_cause[0].cause,
          plain_language: failures_by_cause[0].plain_language,
          affected_count: failures_by_cause[0].affected_count,
        }
      : null,
  };
}

/** Parse a window label like "24h" / "7d" / "60m" into hours (default 24). */
export function windowToHours(label: string): number {
  const m = /^(\d+)\s*([hdm])$/i.exec(label.trim());
  if (!m) return 24;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  if (unit === 'h') return n;
  if (unit === 'd') return n * 24;
  if (unit === 'm') return Math.max(1, Math.round(n / 60));
  return 24;
}

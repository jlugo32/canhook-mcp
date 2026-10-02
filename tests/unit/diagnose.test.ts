import { describe, expect, it } from 'vitest';
import { classify, diagnose, windowToHours } from '../../src/tools/diagnose.js';

const row = (o: Partial<{ status: string; response_status: number | null; error: string | null; destination_url: string }>) => ({
  status: 'failed', response_status: null, error: null, destination_url: 'https://d.example', ...o,
});

describe('classify', () => {
  it.each([
    [row({ error: 'SSRF: private address' }), 'ssrf_blocked'],
    [row({ error: 'Connection timed out after 10s' }), 'timeout'],
    [row({ error: 'Could not resolve host' }), 'dns'],
    [row({ response_status: 502 }), 'http_5xx'],
    [row({ response_status: 401 }), 'http_4xx'],
    [row({ response_status: 0 }), 'no_response'],
    [row({ response_status: 302 }), 'unknown'],
  ])('%j → %s', (r, cause) => {
    expect(classify(r).cause).toBe(cause);
  });
});

describe('diagnose', () => {
  it('returns a null rate and no primary diagnosis for an empty window', () => {
    expect(diagnose([], '24h')).toMatchObject({ total: 0, success_rate: null, primary_diagnosis: null });
  });

  it('ranks causes by count and keeps the top 5 destinations', () => {
    const rows = [
      row({ response_status: 500, destination_url: 'https://a' }),
      row({ response_status: 500, destination_url: 'https://a' }),
      row({ response_status: 404, destination_url: 'https://b' }),
      row({ status: 'retrying', response_status: 503, destination_url: 'https://c' }),
      row({ status: 'success', response_status: 200 }),
    ];
    const d = diagnose(rows, '24h');
    expect(d.failure_count).toBe(4);
    expect(d.failures_by_cause[0]).toMatchObject({ cause: 'http_5xx', affected_count: 3 });
    expect(d.top_failing_destinations[0]).toEqual({ url: 'https://a', count: 2 });
    expect(d.success_rate).toBe(0.2);
  });
});

describe('windowToHours', () => {
  it.each([['24h', 24], ['7d', 168], ['90m', 2], ['10m', 1], ['bogus', 24], [' 3H ', 3]])('%s → %i', (w, h) => {
    expect(windowToHours(w)).toBe(h);
  });
});

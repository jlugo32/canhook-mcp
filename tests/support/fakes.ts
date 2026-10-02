import { HostError, type Deps, type Introspection, type Row } from '../../src/contracts/index.js';

/**
 * In-memory implementation of every contract. Two owners (1 and 2) so tests
 * can prove one user never sees the other's rows. Write methods are wrapped
 * with `spy` (vi.fn in tests) so tests can assert whether a write was attempted.
 * No vitest import here, so scripts (the conformance server) can use it too.
 */
type Spy = <F extends (...args: any[]) => any>(f: F) => F;
export const ALICE = 1;
export const BOB = 2;

const endpoints: Row[] = [
  { id: 10, token: 'ep_alice', user_id: ALICE, name: 'stripe-prod', is_active: 1, request_count: 3 },
  { id: 20, token: 'ep_bob', user_id: BOB, name: 'bob-private', is_active: 1, request_count: 1 },
];
const requests: Row[] = [
  { id: 100, endpoint_id: 10, method: 'POST', body: '{"type":"invoice.paid"}' },
  { id: 101, endpoint_id: 10, method: 'POST', body: 'x'.repeat(150 * 1024) },
  { id: 200, endpoint_id: 20, method: 'POST', body: 'bob secret' },
];
const deliveries: Row[] = [
  { id: 500, endpoint_id: 10, relay_rule_id: 1, status: 'failed', response_status: 503, error: null, destination_url: 'https://a.example/hook' },
  { id: 501, endpoint_id: 10, relay_rule_id: 1, status: 'success', response_status: 200, error: null, destination_url: 'https://a.example/hook' },
  { id: 600, endpoint_id: 20, relay_rule_id: 2, status: 'failed', response_status: 500, error: null, destination_url: 'https://b.example' },
];

const owned = (u: number, ref: string) =>
  endpoints.find((e) => e.user_id === u && (e.token === ref || String(e.id) === ref)) ?? null;
const ownerOfEndpoint = (endpointId: unknown) => endpoints.find((e) => e.id === endpointId)?.user_id;

/** token → introspection result */
export const TOKENS: Record<string, Introspection> = {
  'tok-rw': { active: true, userId: ALICE, scopes: ['canhook.read', 'canhook.write'], clientId: 'claude' },
  'tok-ro': { active: true, userId: ALICE, scopes: ['canhook.read'], clientId: 'claude' },
  'tok-bob': { active: true, userId: BOB, scopes: ['canhook.read', 'canhook.write'], clientId: 'claude' },
};

export function fakeDeps(spy: Spy = (f) => f): Deps {
  return {
    endpoints: {
      list: async (u) => endpoints.filter((e) => e.user_id === u),
      get: async (u, ref) => owned(u, ref),
      exists: async (u, ref) => owned(u, ref) !== null,
      create: spy(async (_u, input) => ({ ok: true, endpoint: { id: 11, ...input } })),
      update: spy(async (_u, ref, patch) => ({ ok: true, ref, patch })),
      delete: spy(async (_u, ref) => ({ ok: true, deleted: ref })),
    },
    requests: {
      list: async (u, ref, o) => {
        const ep = owned(u, ref);
        return ep ? requests.filter((r) => r.endpoint_id === ep.id).slice(0, o.limit) : [];
      },
      get: async (u, id) => {
        const r = requests.find((x) => x.id === id);
        return r && ownerOfEndpoint(r.endpoint_id) === u ? { ...r } : null;
      },
    },
    relayRules: {
      list: async (u, ref) => (owned(u, ref) ? [{ id: 1, name: 'to-a', destination_url: 'https://a.example/hook' }] : []),
      create: spy(async (_u, input) => {
        if (String(input.destination_url).includes('169.254.')) {
          throw new HostError('ssrf_blocked', 'Destination blocked by the SSRF guard (private/reserved IP addresses are not allowed).');
        }
        return { ok: true, rule: input };
      }),
    },
    deliveries: {
      list: async (u, o) => deliveries.filter((d) => ownerOfEndpoint(d.endpoint_id) === u && (!o.status || d.status === o.status)).slice(0, o.limit),
      get: async (u, id) => deliveries.find((d) => d.id === id && ownerOfEndpoint(d.endpoint_id) === u) ?? null,
      diagnoseRows: async (u, ref) => {
        const ep = owned(u, ref);
        return ep ? (deliveries.filter((d) => d.endpoint_id === ep.id) as any) : [];
      },
      retry: spy(async (_u, id) => ({ ok: true, requeued: id })),
    },
    replay: {
      replay: spy(async (_u, input) => ({ ok: true, status: 200, duration_ms: 12, destination: input.destination_url })),
    },
    usage: {
      get: async () => ({ plan: 'pro', endpoints_used: 1, captures_today: 3, relay_today: 1 }),
    },
    audit: { record: spy(async () => {}) },
    introspector: {
      introspect: async (t) => TOKENS[t] ?? { active: false, scopes: [] },
    },
  };
}

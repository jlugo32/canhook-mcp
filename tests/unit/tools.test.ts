import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { connect } from '../support/client.js';
import { ALICE, BOB } from '../support/fakes.js';
import { fakeDeps } from '../support/spied.js';

const READ_ONLY = ['canhook.read'];
const fixture = (f: string) => JSON.parse(readFileSync(new URL(`../fixtures/${f}`, import.meta.url), 'utf8'));
const v1Baseline = fixture('tools-list.v1-baseline.json');
const golden = fixture('tools-list.json');
const sorted = (tools: any[]) => [...tools].sort((a, b) => a.name.localeCompare(b.name));

/**
 * The parts of a tool a model actually reads. Wire-format details that the
 * SDK v2 / spec move changed on purpose are excluded: the $schema dialect
 * (draft-07 → 2020-12), the removed 2025-11 experimental execution.taskSupport,
 * propertyNames on records, and additionalProperties:false (never enforced;
 * extra arguments were and are stripped).
 */
const contractOf = (t: any) => ({
  name: t.name,
  title: t.title,
  description: t.description,
  annotations: t.annotations,
  required: [...(t.inputSchema.required ?? [])].sort(),
  properties: Object.fromEntries(
    Object.entries(t.inputSchema.properties ?? {}).map(([k, v]: [string, any]) => {
      const { propertyNames: _drop, ...rest } = v;
      return [k, rest];
    }),
  ),
});

describe('tools/list', () => {
  it('keeps the pre-extraction v1 contract (names, descriptions, annotations, parameters)', async () => {
    const { client } = await connect(fakeDeps());
    const { tools } = await client.listTools();
    expect(sorted(tools).map(contractOf)).toEqual(sorted(v1Baseline).map(contractOf));
  });

  it('matches the golden tools/list snapshot exactly (update tests/fixtures/tools-list.json on purpose only)', async () => {
    const { client } = await connect(fakeDeps());
    expect(sorted((await client.listTools()).tools)).toEqual(golden);
  });

  it('exposes exactly 15 tools and no catch-all tool', async () => {
    const { client } = await connect(fakeDeps());
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toHaveLength(15);
    expect(names.some((n) => /api_request|raw|execute|http/.test(n))).toBe(false);
  });
});

describe('read tools', () => {
  it('list_endpoints returns only the caller\'s endpoints', async () => {
    const { call } = await connect(fakeDeps(), { userId: ALICE });
    const { isError, data } = await call('list_endpoints');
    expect(isError).toBe(false);
    expect(data.map((e: any) => e.token)).toEqual(['ep_alice']);
  });

  it('get_endpoint finds by token and by numeric id', async () => {
    const { call } = await connect(fakeDeps(), { userId: ALICE });
    expect((await call('get_endpoint', { endpoint: 'ep_alice' })).data.id).toBe(10);
    expect((await call('get_endpoint', { endpoint: '10' })).data.token).toBe('ep_alice');
  });

  it('list_requests returns the endpoint\'s requests', async () => {
    const { call } = await connect(fakeDeps(), { userId: ALICE });
    const { data } = await call('list_requests', { endpoint: 'ep_alice' });
    expect(data.map((r: any) => r.id)).toEqual([100, 101]);
  });

  it('get_request caps bodies over 100KB and says how much was cut', async () => {
    const { call } = await connect(fakeDeps(), { userId: ALICE });
    const { data } = await call('get_request', { request_id: 101 });
    expect(data.body.length).toBeLessThan(150 * 1024);
    expect(data.body).toMatch(/…\[truncated 51200 bytes\]$/);
  });

  it('list_relay_rules, list_deliveries, get_delivery, get_usage work for the owner', async () => {
    const { call } = await connect(fakeDeps(), { userId: ALICE });
    expect((await call('list_relay_rules', { endpoint: 'ep_alice' })).data).toHaveLength(1);
    expect((await call('list_deliveries', { status: 'failed' })).data.map((d: any) => d.id)).toEqual([500]);
    expect((await call('get_delivery', { delivery_id: 500 })).data.response_status).toBe(503);
    expect((await call('get_usage')).data.plan).toBe('pro');
  });

  it('diagnose_endpoint groups failures into a plain-language diagnosis', async () => {
    const { call } = await connect(fakeDeps(), { userId: ALICE });
    const { data } = await call('diagnose_endpoint', { endpoint: 'ep_alice', window: '7d' });
    expect(data).toMatchObject({ window: '7d', total: 2, success_count: 1, failure_count: 1, success_rate: 0.5 });
    expect(data.primary_diagnosis.cause).toBe('http_5xx');
    expect(data.top_failing_destinations).toEqual([{ url: 'https://a.example/hook', count: 1 }]);
  });
});

describe('ownership (IDOR)', () => {
  it.each([
    ['get_endpoint', { endpoint: 'ep_bob' }, 'Endpoint not found.'],
    ['get_endpoint', { endpoint: '20' }, 'Endpoint not found.'],
    ['list_requests', { endpoint: 'ep_bob' }, 'Endpoint not found.'],
    ['list_relay_rules', { endpoint: 'ep_bob' }, 'Endpoint not found.'],
    ['diagnose_endpoint', { endpoint: 'ep_bob' }, 'Endpoint not found.'],
    ['get_request', { request_id: 200 }, 'Request not found.'],
    ['get_delivery', { delivery_id: 600 }, 'Delivery not found.'],
  ])('%s on another user\'s object → not found (%j)', async (tool, args, msg) => {
    const { call } = await connect(fakeDeps(), { userId: ALICE });
    const { isError, data } = await call(tool, args);
    expect(isError).toBe(true);
    expect(data).toEqual({ error: msg });
  });

  it('list_deliveries never includes another user\'s deliveries', async () => {
    const { call } = await connect(fakeDeps(), { userId: BOB });
    expect((await call('list_deliveries')).data.map((d: any) => d.id)).toEqual([600]);
  });
});

describe('scope enforcement', () => {
  const writes: [string, Record<string, unknown>][] = [
    ['create_endpoint', { name: 'x' }],
    ['update_endpoint', { endpoint: 'ep_alice', name: 'y' }],
    ['create_relay_rule', { endpoint: 'ep_alice', name: 'r', destination_url: 'https://a.example' }],
    ['replay_request', { request_id: 100, destination_url: 'https://a.example' }],
    ['retry_delivery', { delivery_id: 500 }],
    ['delete_endpoint', { endpoint: 'ep_alice', confirm: true }],
  ];

  it.each(writes)('%s is refused with only canhook.read, and no write is attempted', async (tool, args) => {
    const deps = fakeDeps();
    const { call } = await connect(deps, { userId: ALICE, scopes: READ_ONLY });
    const { isError, data } = await call(tool, args);
    expect(isError).toBe(true);
    expect(data.error).toBe('This tool requires the canhook.write scope, which this connection was not granted.');
    for (const spy of [deps.endpoints.create, deps.endpoints.update, deps.endpoints.delete, deps.relayRules.create, deps.replay.replay, deps.deliveries.retry]) {
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it('read tools are refused with no scopes', async () => {
    const { call } = await connect(fakeDeps(), { userId: ALICE, scopes: [] });
    const { isError, data } = await call('list_endpoints');
    expect(isError).toBe(true);
    expect(data.error).toMatch(/requires the canhook\.read scope/);
  });
});

describe('write tools', () => {
  it('create_endpoint passes name and description through', async () => {
    const deps = fakeDeps();
    const { call } = await connect(deps, { userId: ALICE });
    await call('create_endpoint', { name: 'new', description: 'd' });
    expect(deps.endpoints.create).toHaveBeenCalledWith(ALICE, { name: 'new', description: 'd' });
  });

  it('update_endpoint maps is_active to 1/0 and sends only given fields', async () => {
    const deps = fakeDeps();
    const { call } = await connect(deps, { userId: ALICE });
    await call('update_endpoint', { endpoint: 'ep_alice', is_active: false, mock_status: 202 });
    expect(deps.endpoints.update).toHaveBeenCalledWith(ALICE, 'ep_alice', { is_active: 0, mock_status: 202 });
  });

  it('create_relay_rule surfaces the host SSRF block as an actionable error', async () => {
    const { call } = await connect(fakeDeps(), { userId: ALICE });
    const { isError, data } = await call('create_relay_rule', {
      endpoint: 'ep_alice', name: 'meta', destination_url: 'http://169.254.169.254/latest',
    });
    expect(isError).toBe(true);
    expect(data.error).toMatch(/SSRF guard/);
  });

  it('replay_request and retry_delivery call the host with the caller id', async () => {
    const deps = fakeDeps();
    const { call } = await connect(deps, { userId: ALICE });
    expect((await call('replay_request', { request_id: 100, destination_url: 'https://a.example' })).data.status).toBe(200);
    await call('retry_delivery', { delivery_id: 500 });
    expect(deps.replay.replay).toHaveBeenCalledWith(ALICE, { request_id: 100, destination_url: 'https://a.example' });
    expect(deps.deliveries.retry).toHaveBeenCalledWith(ALICE, 500);
  });

  it('delete_endpoint refuses without confirm=true and does not delete', async () => {
    const deps = fakeDeps();
    const { call } = await connect(deps, { userId: ALICE });
    const { isError, data } = await call('delete_endpoint', { endpoint: 'ep_alice', confirm: false });
    expect(isError).toBe(true);
    expect(data.error).toMatch(/set confirm=true/);
    expect(deps.endpoints.delete).not.toHaveBeenCalled();
    await call('delete_endpoint', { endpoint: 'ep_alice', confirm: true });
    expect(deps.endpoints.delete).toHaveBeenCalledWith(ALICE, 'ep_alice');
  });
});

describe('rate limit', () => {
  it('refuses calls over the per-minute budget with a retry hint', async () => {
    const { call } = await connect(fakeDeps(), {}, 2);
    expect((await call('get_usage')).isError).toBe(false);
    expect((await call('get_usage')).isError).toBe(false);
    const third = await call('get_usage');
    expect(third.isError).toBe(true);
    expect(third.data.error).toMatch(/Rate limit exceeded/);
  });
});

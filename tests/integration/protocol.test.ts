import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHttpApp } from '../../src/server.js';
import { fakeDeps } from '../support/fakes.js';

/**
 * Protocol behaviour over real HTTP: the 2026-07-28 (modern, stateless) rules
 * and the 2025-era (legacy) leg served from the same /mcp route (ADR-0001).
 */
const MODERN = '2026-07-28';
let server: Server;
let base: string;

beforeAll(async () => {
  const app = createHttpApp({
    deps: fakeDeps(), baseUrl: 'https://canhook.test', issuer: 'https://canhook.test',
    rateLimitPerMin: 1000, name: 'canhook', version: '1.0.0',
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const meta = (version = MODERN) => ({
  'io.modelcontextprotocol/protocolVersion': version,
  'io.modelcontextprotocol/clientCapabilities': {},
});

async function modern(
  method: string,
  params: Record<string, unknown> = {},
  opts: { token?: string | null; headers?: Record<string, string>; version?: string; name?: string } = {},
) {
  const token = opts.token === undefined ? 'tok-rw' : opts.token;
  const res = await fetch(base + '/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': opts.version ?? MODERN,
      'mcp-method': method,
      ...(opts.name ? { 'mcp-name': opts.name } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...opts.headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: meta(opts.version) } }),
  });
  const text = await res.text();
  const line = text.split('\n').find((l) => l.startsWith('data:'));
  let body: any = null;
  try { body = JSON.parse(line ? line.slice(5) : text); } catch { body = text; }
  return { status: res.status, body };
}

describe('2026-07-28 (modern) leg', () => {
  it('server/discover advertises 2026-07-28 and the tools capability', async () => {
    const { status, body } = await modern('server/discover');
    expect(status).toBe(200);
    expect(body.result.supportedVersions).toContain(MODERN);
    expect(body.result.capabilities.tools).toBeDefined();
  });

  it('tools/list carries resultType and private cache hints, in alphabetical order', async () => {
    const { body } = await modern('tools/list');
    expect(body.result.resultType).toBe('complete');
    expect(body.result.ttlMs).toBe(300_000);
    expect(body.result.cacheScope).toBe('private');
    const names = body.result.tools.map((t: any) => t.name);
    expect(names).toEqual([...names].sort());
  });

  it('tools/call returns resultType complete', async () => {
    const { body } = await modern('tools/call', { name: 'get_usage', arguments: {} }, { name: 'get_usage' });
    expect(body.result.resultType).toBe('complete');
    expect(JSON.parse(body.result.content[0].text).plan).toBe('pro');
  });

  it('Mcp-Name that does not match the body → 400 HeaderMismatch (-32020)', async () => {
    const { status, body } = await modern('tools/call', { name: 'get_usage', arguments: {} }, { name: 'delete_endpoint' });
    expect(status).toBe(400);
    expect(body.error.code).toBe(-32020);
  });

  it('Mcp-Method that does not match the body → 400 HeaderMismatch (-32020)', async () => {
    const { status, body } = await modern('tools/list', {}, { headers: { 'mcp-method': 'prompts/list' } });
    expect(status).toBe(400);
    expect(body.error.code).toBe(-32020);
  });

  it('unknown protocol version → 400 UnsupportedProtocolVersion (-32022) listing supported versions', async () => {
    const { status, body } = await modern('tools/list', {}, { version: '2099-01-01' });
    expect(status).toBe(400);
    expect(body.error.code).toBe(-32022);
    expect(body.error.data.supported).toContain(MODERN);
  });

  it('removed methods (ping, logging/setLevel) → 404 + -32601', async () => {
    for (const m of ['ping', 'logging/setLevel']) {
      const { status, body } = await modern(m);
      expect(status).toBe(404);
      expect(body.error.code).toBe(-32601);
    }
  });

  it('bearer gate still answers first: no token → 401', async () => {
    expect((await modern('server/discover', {}, { token: null })).status).toBe(401);
  });
});

describe('HTTP hardening', () => {
  it('a browser Origin other than our own host → 403', async () => {
    expect((await modern('tools/list', {}, { headers: { origin: 'https://evil.example' } })).status).toBe(403);
  });

  it('our own Origin is allowed', async () => {
    expect((await modern('tools/list', {}, { headers: { origin: 'https://canhook.test' } })).status).toBe(200);
  });

  it('an unexpected Host header (DNS rebinding) → 403; our vhost name passes', async () => {
    // node:http, not fetch: undici silently drops a custom Host header.
    const status = (host: string) => new Promise<number>((resolve) => {
      const { port } = new URL(base);
      request({ host: '127.0.0.1', port, path: '/healthz', headers: { host } }, (r) => { r.resume(); resolve(r.statusCode ?? 0); }).end();
    });
    expect(await status('evil.example')).toBe(403);
    expect(await status('canhook.test')).toBe(200);
  });

  it('no GET stream and no sessions: GET /mcp → 405', async () => {
    const res = await fetch(base + '/mcp', { headers: { authorization: 'Bearer tok-rw', accept: 'text/event-stream' } });
    expect(res.status).toBe(405);
  });
});

describe('real SDK clients against one route', () => {
  const transport = () =>
    new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { authorization: 'Bearer tok-ro' } } });

  it('a client pinned to 2026-07-28 connects without initialize and calls a tool', async () => {
    const client = new Client({ name: 't', version: '1' }, { versionNegotiation: { mode: { pin: MODERN } } });
    await client.connect(transport());
    expect(client.getProtocolEra()).toBe('modern');
    expect((await client.listTools()).tools).toHaveLength(15);
    const r = (await client.callTool({ name: 'list_endpoints', arguments: {} })) as any;
    expect(JSON.parse(r.content[0].text).map((e: any) => e.token)).toEqual(['ep_alice']);
    await client.close();
  });

  it('a default (2025-era) client still works on the same route', async () => {
    const client = new Client({ name: 't', version: '1' });
    await client.connect(transport());
    expect(client.getProtocolEra()).toBe('legacy');
    expect((await client.listTools()).tools).toHaveLength(15);
    await client.close();
  });
});

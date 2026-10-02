import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createInternalApi } from '../../src/adapters/canhook/internal-api.js';
import { createIntrospector } from '../../src/adapters/canhook/introspection.js';
import { HostError } from '../../src/contracts/index.js';

/** One fake "PHP app" that plays both /oauth/introspect and /internal/*. */
type Seen = { method?: string; url?: string; headers: IncomingMessage['headers']; body: string };
let seen: Seen[] = [];
let reply: (req: Seen) => { status: number; body: unknown } = () => ({ status: 200, body: {} });
let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const s: Seen = { method: req.method, url: req.url, headers: req.headers, body };
      seen.push(s);
      const r = reply(s);
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
    });
  });
  server.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => { seen = []; });

describe('introspection adapter', () => {
  const make = () => createIntrospector({ url: base + '/oauth/introspect', secret: 's3cret', cacheTtlMs: 60_000 });

  it('maps an RFC 7662 response and sends the shared secret', async () => {
    reply = () => ({ status: 200, body: { active: true, sub: '7', scope: 'canhook.read canhook.write', client_id: 'claude', aud: 'https://canhook.com/mcp', exp: 99 } });
    const r = await make().introspect('abc');
    expect(r).toEqual({ active: true, userId: 7, scopes: ['canhook.read', 'canhook.write'], clientId: 'claude', audience: ['https://canhook.com/mcp'], expiresAt: 99 });
    expect(seen[0].headers['x-introspection-secret']).toBe('s3cret');
    expect(seen[0].body).toBe('token=abc');
  });

  it('caches by token hash (one upstream call for two lookups)', async () => {
    reply = () => ({ status: 200, body: { active: true, sub: 7, scope: 'canhook.read' } });
    const i = make();
    await i.introspect('t1');
    await i.introspect('t1');
    expect(seen).toHaveLength(1);
  });

  it.each([
    ['inactive', { status: 200, body: { active: false } }],
    ['active without sub', { status: 200, body: { active: true, scope: 'canhook.read' } }],
    ['active with sub 0', { status: 200, body: { active: true, sub: 0 } }],
    ['upstream 500', { status: 500, body: {} }],
    ['non-JSON', { status: 200, body: 'oops' }],
  ])('%s → inactive', async (_n, r) => {
    reply = () => r;
    expect(await make().introspect('x')).toEqual({ active: false, scopes: [] });
  });

  it('empty token never calls upstream', async () => {
    expect((await make().introspect('')).active).toBe(false);
    expect(seen).toHaveLength(0);
  });
});

describe('internal API adapter', () => {
  const call = () => createInternalApi({ baseUrl: base + '/internal', hostHeader: 'canhook.com', secret: 'int-secret' });

  it('sends Host, secret and user id headers with a JSON body', async () => {
    reply = () => ({ status: 200, body: { ok: true, id: 5 } });
    expect(await call()(42, 'POST', '/endpoints', { name: 'x' })).toEqual({ ok: true, id: 5 });
    expect(seen[0]).toMatchObject({ method: 'POST', url: '/internal/endpoints', body: '{"name":"x"}' });
    expect(seen[0].headers).toMatchObject({ host: 'canhook.com', 'x-internal-secret': 'int-secret', 'x-canhook-user': '42' });
  });

  it('DELETE without a body sends no content-length', async () => {
    reply = () => ({ status: 200, body: { ok: true } });
    await call()(1, 'DELETE', '/endpoints/ep_1');
    expect(seen[0].headers['content-length']).toBeUndefined();
  });

  it.each([
    [{ status: 422, body: { error: 'ssrf_blocked' } }, 'ssrf_blocked', /SSRF guard/],
    [{ status: 402, body: { error: 'plan_limit' } }, 'plan_limit', /Plan limit reached/],
    [{ status: 200, body: { error: 'relay_disabled', message: 'Custom host message.' } }, 'relay_disabled', /^Custom host message\.$/],
    [{ status: 502, body: 'bad gateway' }, 'error', /Request failed \(HTTP 502\)/],
  ])('maps %j to HostError(%s)', async (r, code, msg) => {
    reply = () => r;
    const err = await call()(1, 'POST', '/replay', {}).catch((e) => e);
    expect(err).toBeInstanceOf(HostError);
    expect(err.code).toBe(code);
    expect(err.message).toMatch(msg);
  });
});

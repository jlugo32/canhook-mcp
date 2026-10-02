import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHttpApp } from '../../src/server.js';
import { fakeDeps } from '../support/fakes.js';

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

function rpc(body: unknown, token?: string) {
  return fetch(base + '/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function payload(res: Response) {
  const text = await res.text();
  const data = text.split('\n').find((l) => l.startsWith('data:'));
  return JSON.parse(data ? data.slice(5) : text);
}

describe('bearer gate', () => {
  it('401 + WWW-Authenticate pointing at protected-resource metadata when no token', async () => {
    const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe(
      'Bearer realm="canhook", resource_metadata="https://canhook.test/.well-known/oauth-protected-resource"',
    );
    expect(await res.json()).toEqual({ jsonrpc: '2.0', error: { code: -32001, message: 'invalid_token' }, id: null });
  });

  it('401 for an unknown token', async () => {
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'nope')).status).toBe(401);
  });

  it('a valid token can initialize and list tools', async () => {
    const init = await rpc({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } },
    }, 'tok-ro');
    expect(init.status).toBe(200);
    expect((await payload(init)).result.serverInfo.name).toBe('canhook');

    const list = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, 'tok-ro');
    expect((await payload(list)).result.tools).toHaveLength(15);
  });
});

describe('metadata', () => {
  it('serves RFC 9728 protected-resource metadata', async () => {
    const res = await fetch(base + '/.well-known/oauth-protected-resource');
    expect(await res.json()).toEqual({
      resource: 'https://canhook.test/mcp',
      authorization_servers: ['https://canhook.test'],
      scopes_supported: ['canhook.read', 'canhook.write'],
      bearer_methods_supported: ['header'],
    });
  });

  it('healthz', async () => {
    expect(await (await fetch(base + '/healthz')).json()).toEqual({ ok: true });
  });
});

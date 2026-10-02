import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { Deps } from '../../src/contracts/index.js';
import type { Ctx } from '../../src/core/context.js';
import { buildServer, type ServerOptions } from '../../src/server.js';

let nextUser = 1000;

/**
 * Connect a real MCP client to a real server over an in-memory pipe.
 * Each call gets a fresh user id by default so the module-level rate limiter
 * never leaks between tests.
 */
export async function connect(deps: Deps, ctx: Partial<Ctx> = {}, rateLimitPerMin = 1000) {
  const fullCtx: Ctx = { userId: ctx.userId ?? nextUser++, scopes: ctx.scopes ?? ['canhook.read', 'canhook.write'] };
  const opts: ServerOptions = {
    deps, baseUrl: 'https://canhook.test', issuer: 'https://canhook.test', rateLimitPerMin, name: 'canhook', version: '1.0.0',
  };
  const server = buildServer(fullCtx, opts);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return {
    client,
    /** Call a tool and return the parsed JSON text payload plus the isError flag. */
    async call(name: string, args: Record<string, unknown> = {}) {
      const r = (await client.callTool({ name, arguments: args })) as { content: { type: string; text: string }[]; isError?: boolean };
      return { isError: r.isError === true, data: JSON.parse(r.content[0].text) };
    },
  };
}

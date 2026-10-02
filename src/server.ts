import type { NextFunction, Request, Response } from 'express';
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer, type AuthInfo } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import type { Deps } from './contracts/index.js';
import { SCOPES, type Ctx } from './core/context.js';
import { registerReadTools } from './tools/read.js';
import { registerWriteTools } from './tools/write.js';

export interface ServerOptions {
  deps: Deps;
  /** Public origin, e.g. https://canhook.com — the protected resource is <baseUrl>/mcp. */
  baseUrl: string;
  /** OAuth authorization server issuer. */
  issuer: string;
  rateLimitPerMin: number;
  name: string;
  version: string;
  /**
   * Browser Origin hostnames allowed to call /mcp. Requests without an Origin
   * header (every server-side MCP client) always pass. Defaults to the public host.
   */
  allowedOrigins?: string[];
}

/** Cache hints for the 2026-07-28 cacheable list results. Per-user data → always private. */
const CACHE_HINTS = {
  'tools/list': { ttlMs: 300_000, cacheScope: 'private' },
} as const;

const INSTRUCTIONS =
  'Inspect captured webhooks, diagnose relay delivery failures, replay requests, and manage CanHook ' +
  'endpoints. Read tools require the canhook.read scope; write tools require canhook.write. ' +
  'Use diagnose_endpoint to explain in plain language why an endpoint\'s webhook deliveries are failing.';

/** Build one server instance for one caller. The SDK calls this once per request (stateless). */
export function buildServer(ctx: Ctx, opts: ServerOptions): McpServer {
  const server = new McpServer(
    { name: opts.name, version: opts.version },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS, cacheHints: { ...CACHE_HINTS } },
  );
  const env = { ctx, deps: opts.deps, rateLimitPerMin: opts.rateLimitPerMin };
  // tools/list follows registration order. Register alphabetically so the list is
  // deterministic (stable cache keys, stable golden snapshots, no ordering bias).
  const pending: Parameters<McpServer['registerTool']>[] = [];
  const collector = { registerTool: (...args: Parameters<McpServer['registerTool']>) => void pending.push(args) } as unknown as McpServer;
  registerReadTools(collector, env);
  registerWriteTools(collector, env);
  for (const args of pending.sort((a, b) => a[0].localeCompare(b[0]))) {
    (server.registerTool as (...a: unknown[]) => unknown)(...args);
  }
  return server;
}

function extractToken(req: Request): string | null {
  const h = req.headers['authorization'];
  if (typeof h !== 'string') return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : null;
}

/** The caller identity travels from the bearer gate to the per-request factory in AuthInfo.extra. */
function ctxFromAuth(auth: AuthInfo | undefined): Ctx {
  const userId = Number(auth?.extra?.userId);
  if (!auth || !Number.isInteger(userId) || userId <= 0) {
    // Unreachable behind bearerGate; fail closed if the wiring is ever broken.
    throw new Error('Unauthenticated request reached the MCP handler.');
  }
  return { userId, scopes: [...auth.scopes] };
}

/** GATE 1 (bearer): introspect BEFORE anything else. No tool runs for a bad token. */
function bearerGate(opts: ServerOptions) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const token = extractToken(req);
    const intro = token ? await opts.deps.introspector.introspect(token) : { active: false, scopes: [] };
    if (!token || !intro.active || !intro.userId) {
      res.setHeader(
        'WWW-Authenticate',
        `Bearer realm="canhook", resource_metadata="${opts.baseUrl}/.well-known/oauth-protected-resource"`,
      );
      res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'invalid_token' }, id: null });
      return;
    }
    req.auth = {
      token,
      clientId: intro.clientId ?? '',
      scopes: intro.scopes,
      expiresAt: intro.expiresAt,
      extra: { userId: intro.userId },
    };
    next();
  };
}

/** The Express app that serves /mcp. Exported so tests can drive it without a listener. */
export function createHttpApp(opts: ServerOptions) {
  const publicHost = new URL(opts.baseUrl).hostname;
  // Host validation (DNS-rebinding protection): the public vhost name that OLS
  // forwards, plus loopback for local health checks.
  const app = createMcpExpressApp({
    host: '127.0.0.1',
    allowedHosts: [publicHost, '127.0.0.1', 'localhost'],
    allowedOrigins: opts.allowedOrigins ?? [publicHost],
    jsonLimit: '1mb',
  });

  // RFC 9728 Protected Resource Metadata (also served by PHP; harmless duplicate for clients that probe here).
  app.get('/.well-known/oauth-protected-resource', (_req: Request, res: Response) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.json({
      resource: opts.baseUrl + '/mcp',
      authorization_servers: [opts.issuer],
      scopes_supported: [SCOPES.read, SCOPES.write],
      bearer_methods_supported: ['header'],
    });
  });

  // Stateless: one handler; the SDK builds a fresh server per request and serves
  // both 2026-07-28 (modern) and 2025-era (legacy, per request, no sessions) clients.
  const handler = createMcpHandler(({ authInfo }) => buildServer(ctxFromAuth(authInfo), opts), {
    onerror: (e) => console.error(JSON.stringify({ level: 'error', msg: 'mcp_handler_error', error: e.message })),
  });
  const node = toNodeHandler(handler);
  app.all('/mcp', bearerGate(opts), (req: Request, res: Response) => void node(req, res, req.body));

  app.get('/healthz', (_req: Request, res: Response) => res.json({ ok: true }));
  return app;
}

export function runHttp(opts: ServerOptions, port: number, host: string): void {
  createHttpApp(opts).listen(port, host, () => {
    console.error(`canhook-mcp listening on http://${host}:${port}/mcp`);
  });
}

export async function runStdio(opts: ServerOptions, token: string): Promise<void> {
  // Single-user stdio mode for local/CLI use.
  const intro = token ? await opts.deps.introspector.introspect(token) : { active: false, scopes: [] };
  if (!intro.active || !intro.userId) {
    throw new Error('stdio mode requires a valid CANHOOK_TOKEN environment variable.');
  }
  const ctx: Ctx = { userId: intro.userId, scopes: intro.scopes };
  serveStdio(() => buildServer(ctx, opts));
}

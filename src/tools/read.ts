import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { SCOPES, type ToolEnv } from '../core/context.js';
import { requireScope } from '../lib/scope.js';
import { cap, ok, err } from '../lib/format.js';
import { rateLimit } from '../lib/ratelimit.js';
import { diagnose, windowToHours } from './diagnose.js';

/**
 * Register the 9 read tools. Each handler runs the pipeline gate that belongs to
 * the tool layer: scope assertion (canhook.read) → rate limit → owner-scoped
 * query. The bearer gate already ran in server.ts before we ever get here.
 */
export function registerReadTools(server: McpServer, { ctx, deps, rateLimitPerMin }: ToolEnv): void {
  const readScope = () => requireScope(ctx.scopes, SCOPES.read);
  const guardRate = () => {
    if (!rateLimit(ctx.userId, rateLimitPerMin)) throw new Error('Rate limit exceeded — slow down and retry shortly.');
  };

  server.registerTool(
    'list_endpoints',
    {
      description: "List the user's webhook catch endpoints with request counts.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => {
      try { readScope(); guardRate(); return ok(await deps.endpoints.list(ctx.userId)); }
      catch (e) { return err((e as Error).message); }
    },
  );

  server.registerTool(
    'get_endpoint',
    {
      description: 'Get one endpoint (by token or id) with its mock-response config and relay rule count.',
      inputSchema: z.object({ endpoint: z.string().describe('Endpoint token or numeric id') }),
      annotations: { readOnlyHint: true },
    },
    async ({ endpoint }) => {
      try {
        readScope(); guardRate();
        const row = await deps.endpoints.get(ctx.userId, endpoint);
        return row ? ok(row) : err('Endpoint not found.');
      } catch (e) { return err((e as Error).message); }
    },
  );

  server.registerTool(
    'list_requests',
    {
      description: 'List captured requests for an endpoint (newest first).',
      inputSchema: z.object({
        endpoint: z.string().describe('Endpoint token or id'),
        method: z.string().optional().describe('Filter by HTTP method'),
        since: z.number().optional().describe('Only requests with id greater than this'),
        contains: z.string().optional().describe('Only requests whose body contains this substring'),
        limit: z.number().min(1).max(100).default(25),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ endpoint, method, since, contains, limit }) => {
      try {
        readScope(); guardRate();
        if (!(await deps.endpoints.exists(ctx.userId, endpoint))) return err('Endpoint not found.');
        return ok(await deps.requests.list(ctx.userId, endpoint, { method, since, contains, limit: limit ?? 25 }));
      } catch (e) { return err((e as Error).message); }
    },
  );

  server.registerTool(
    'get_request',
    {
      description: 'Get one captured request in full (headers, body, query, etc.). Body is capped at 100KB.',
      inputSchema: z.object({ request_id: z.number().describe('Captured request id') }),
      annotations: { readOnlyHint: true },
    },
    async ({ request_id }) => {
      try {
        readScope(); guardRate();
        const row: any = await deps.requests.get(ctx.userId, request_id);
        if (!row) return err('Request not found.');
        row.body = cap(row.body);
        return ok(row);
      } catch (e) { return err((e as Error).message); }
    },
  );

  server.registerTool(
    'list_relay_rules',
    {
      description: 'List relay rules for an endpoint.',
      inputSchema: z.object({ endpoint: z.string().describe('Endpoint token or id') }),
      annotations: { readOnlyHint: true },
    },
    async ({ endpoint }) => {
      try {
        readScope(); guardRate();
        if (!(await deps.endpoints.exists(ctx.userId, endpoint))) return err('Endpoint not found.');
        return ok(await deps.relayRules.list(ctx.userId, endpoint));
      } catch (e) { return err((e as Error).message); }
    },
  );

  server.registerTool(
    'list_deliveries',
    {
      description: 'List relay delivery attempts, optionally filtered by endpoint, rule, or status.',
      inputSchema: z.object({
        endpoint: z.string().optional().describe('Endpoint token or id'),
        rule_id: z.number().optional().describe('Relay rule id'),
        status: z.enum(['pending', 'success', 'failed', 'retrying']).optional(),
        limit: z.number().min(1).max(100).default(25),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ endpoint, rule_id, status, limit }) => {
      try {
        readScope(); guardRate();
        return ok(await deps.deliveries.list(ctx.userId, { endpoint, ruleId: rule_id, status, limit: limit ?? 25 }));
      } catch (e) { return err((e as Error).message); }
    },
  );

  server.registerTool(
    'get_delivery',
    {
      description: "Get one delivery attempt's full detail, including error and response snippet.",
      inputSchema: z.object({ delivery_id: z.number().describe('Delivery id') }),
      annotations: { readOnlyHint: true },
    },
    async ({ delivery_id }) => {
      try {
        readScope(); guardRate();
        const row = await deps.deliveries.get(ctx.userId, delivery_id);
        return row ? ok(row) : err('Delivery not found.');
      } catch (e) { return err((e as Error).message); }
    },
  );

  server.registerTool(
    'get_usage',
    {
      description: "Get the user's plan, limits, and current usage (captures today, endpoints used, relay usage).",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => {
      try { readScope(); guardRate(); return ok(await deps.usage.get(ctx.userId)); }
      catch (e) { return err((e as Error).message); }
    },
  );

  server.registerTool(
    'diagnose_endpoint',
    {
      description:
        'Diagnose why relay deliveries are failing for an endpoint: success rate, failures grouped by plain-language cause, top failing destinations, and a primary diagnosis. Read-only aggregate.',
      inputSchema: z.object({
        endpoint: z.string().describe('Endpoint token or id'),
        window: z.string().default('24h').describe('Time window, e.g. 24h, 7d, 60m'),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ endpoint, window }) => {
      try {
        readScope(); guardRate();
        if (!(await deps.endpoints.exists(ctx.userId, endpoint))) return err('Endpoint not found.');
        const label = window ?? '24h';
        const rows = await deps.deliveries.diagnoseRows(ctx.userId, endpoint, windowToHours(label));
        return ok(diagnose(rows, label));
      } catch (e) { return err((e as Error).message); }
    },
  );
}

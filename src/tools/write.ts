import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { SCOPES, type ToolEnv } from '../core/context.js';
import { requireScope } from '../lib/scope.js';
import { ok, err } from '../lib/format.js';
import { rateLimit } from '../lib/ratelimit.js';

/**
 * Register the 6 write tools. Each asserts canhook.write, then calls the host's
 * write contracts (in CanHook: the PHP internal API, which holds all
 * SSRF/plan/validation logic). This layer has NO outbound-URL or write logic.
 */
export function registerWriteTools(server: McpServer, { ctx, deps, rateLimitPerMin }: ToolEnv): void {
  const writeScope = () => requireScope(ctx.scopes, SCOPES.write);
  const guardRate = () => {
    if (!rateLimit(ctx.userId, rateLimitPerMin)) throw new Error('Rate limit exceeded — slow down and retry shortly.');
  };

  server.registerTool(
    'create_endpoint',
    {
      description: 'Create a new webhook catch endpoint (subject to plan limits).',
      inputSchema: z.object({
        name: z.string().describe('Endpoint name'),
        description: z.string().optional(),
      }),
    },
    async ({ name, description }) => {
      try { writeScope(); guardRate(); return ok(await deps.endpoints.create(ctx.userId, { name, description })); }
      catch (e) { return err((e as Error).message); }
    },
  );

  server.registerTool(
    'update_endpoint',
    {
      description: 'Update an endpoint: rename, toggle active, or set its mock response (paid plans).',
      inputSchema: z.object({
        endpoint: z.string().describe('Endpoint token or id'),
        name: z.string().optional(),
        is_active: z.boolean().optional(),
        mock_status: z.number().optional(),
        mock_body: z.string().optional(),
        mock_content_type: z.string().optional(),
      }),
    },
    async ({ endpoint, ...rest }) => {
      try {
        writeScope(); guardRate();
        const body: Record<string, unknown> = {};
        if (rest.name !== undefined) body.name = rest.name;
        if (rest.is_active !== undefined) body.is_active = rest.is_active ? 1 : 0;
        if (rest.mock_status !== undefined) body.mock_status = rest.mock_status;
        if (rest.mock_body !== undefined) body.mock_body = rest.mock_body;
        if (rest.mock_content_type !== undefined) body.mock_content_type = rest.mock_content_type;
        return ok(await deps.endpoints.update(ctx.userId, endpoint, body));
      } catch (e) { return err((e as Error).message); }
    },
  );

  server.registerTool(
    'create_relay_rule',
    {
      description:
        'Create a relay rule forwarding captured webhooks to a destination URL. The destination is validated by the CanHook SSRF guard before saving; private/internal IPs are rejected.',
      inputSchema: z.object({
        endpoint: z.string().describe('Endpoint token or id'),
        name: z.string(),
        destination_url: z.string().url(),
        transform_mode: z.enum(['passthrough', 'template', 'filter']).default('passthrough'),
        transform_config: z.record(z.string(), z.any()).optional(),
        custom_headers: z.record(z.string(), z.string()).optional(),
        retry_count: z.number().min(0).max(10).optional(),
      }),
    },
    async (args) => {
      try { writeScope(); guardRate(); return ok(await deps.relayRules.create(ctx.userId, args)); }
      catch (e) { return err((e as Error).message); }
    },
  );

  server.registerTool(
    'replay_request',
    {
      description:
        'Replay a captured request to a destination URL. The destination is validated by the CanHook SSRF guard; private/internal IPs are rejected. Returns the outbound response status, snippet, and duration.',
      inputSchema: z.object({
        request_id: z.number(),
        destination_url: z.string().url(),
      }),
      annotations: { readOnlyHint: false },
    },
    async ({ request_id, destination_url }) => {
      try { writeScope(); guardRate(); return ok(await deps.replay.replay(ctx.userId, { request_id, destination_url })); }
      catch (e) { return err((e as Error).message); }
    },
  );

  server.registerTool(
    'retry_delivery',
    {
      description: 'Re-queue a failed relay delivery so the worker attempts it again.',
      inputSchema: z.object({ delivery_id: z.number() }),
    },
    async ({ delivery_id }) => {
      try { writeScope(); guardRate(); return ok(await deps.deliveries.retry(ctx.userId, delivery_id)); }
      catch (e) { return err((e as Error).message); }
    },
  );

  server.registerTool(
    'delete_endpoint',
    {
      description: 'Permanently delete an endpoint and all its captured requests. Destructive — requires confirm=true.',
      inputSchema: z.object({
        endpoint: z.string().describe('Endpoint token or id'),
        confirm: z.boolean().describe('Must be true to actually delete'),
      }),
      annotations: { destructiveHint: true },
    },
    async ({ endpoint, confirm }) => {
      try {
        writeScope(); guardRate();
        if (confirm !== true) return err('Refusing to delete: set confirm=true to permanently delete this endpoint.');
        return ok(await deps.endpoints.delete(ctx.userId, endpoint));
      } catch (e) { return err((e as Error).message); }
    },
  );
}

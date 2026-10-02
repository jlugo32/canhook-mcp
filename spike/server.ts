// Step 1 spike: hello-world canhook server on TS SDK v2 (2026-07-28 + legacy on one route).
// Fake in-memory data only. Not production code.
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import type { CallToolResult, InputRequiredResult } from '@modelcontextprotocol/server';
import {
  acceptedContent, createMcpHandler, createRequestStateCodec, inputRequired, McpServer, ResourceTemplate,
} from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

const ENDPOINTS = [{ id: 'ep_1', name: 'stripe-prod', request_count: 42 }];
type DelState = { endpoint: string };
const codec = createRequestStateCodec<DelState>({ key: crypto.getRandomValues(new Uint8Array(32)), ttlSeconds: 600 });
const CONFIRM = { type: 'object' as const, properties: { confirm: { type: 'boolean' as const } }, required: ['confirm'] };

function build({ era }: { era?: string } = {}): McpServer {
  const server = new McpServer(
    { name: 'canhook-spike', version: '0.0.1' },
    {
      capabilities: { tools: {}, resources: {}, prompts: {} },
      requestState: { verify: codec.verify },
      cacheHints: {
        'tools/list': { ttlMs: 300_000, cacheScope: 'private' },
        'resources/list': { ttlMs: 30_000, cacheScope: 'private' },
        'resources/templates/list': { ttlMs: 300_000, cacheScope: 'private' },
        'prompts/list': { ttlMs: 300_000, cacheScope: 'private' },
      },
    },
  );

  server.registerTool('canhook_list_endpoints', {
    title: 'List endpoints',
    description: 'List your CanHook webhook endpoints with request counts.',
    inputSchema: z.object({}),
    outputSchema: z.object({ endpoints: z.array(z.object({ id: z.string(), name: z.string(), request_count: z.number() })) }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => {
    const structuredContent = { endpoints: ENDPOINTS };
    return { content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent };
  });

  server.registerTool('canhook_delete_endpoint', {
    title: 'Delete endpoint',
    description: 'Permanently delete an endpoint and its captured requests. Asks the user to confirm first.',
    inputSchema: z.object({ endpoint: z.string() }),
    annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ endpoint }, ctx): Promise<CallToolResult | InputRequiredResult> => {
    const ep = ENDPOINTS.find((e) => e.id === endpoint);
    if (!ep) return { isError: true, content: [{ type: 'text', text: `Endpoint ${endpoint} not found. Call canhook_list_endpoints for valid ids.` }] };
    const ok = acceptedContent<{ confirm: boolean }>(ctx.mcpReq.inputResponses, 'confirm');
    if (!ok?.confirm) {
      return inputRequired({
        inputRequests: { confirm: inputRequired.elicit({ message: `Delete "${ep.name}"? ${ep.request_count} captured requests will be lost.`, requestedSchema: CONFIRM }) },
        requestState: await codec.mint({ endpoint }),
      });
    }
    return { content: [{ type: 'text', text: `Deleted ${ep.name} (spike: nothing really deleted, era=${era}).` }] };
  });

  server.registerResource('endpoint', new ResourceTemplate('canhook://endpoints/{id}', { list: undefined }),
    { mimeType: 'application/json', description: 'One endpoint', cacheHint: { ttlMs: 10_000, cacheScope: 'private' } },
    async (uri, { id }) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(ENDPOINTS.find((e) => e.id === id) ?? null) }] }));

  server.registerPrompt('debug_failing_webhook', {
    title: 'Debug a failing webhook', description: 'Diagnose, check deliveries, verify signature, propose fix.',
    argsSchema: z.object({ endpoint: z.string() }),
  }, ({ endpoint }) => ({ messages: [{ role: 'user', content: { type: 'text', text: `Debug endpoint ${endpoint}: call canhook_diagnose_endpoint first.` } }] }));

  return server;
}

const handler = createMcpHandler(build);
const app = createMcpExpressApp();
const node = toNodeHandler(handler);
app.all('/mcp', (req, res) => void node(req, res, req.body));
const port = Number(process.env.PORT ?? 8799);
app.listen(port, '127.0.0.1', () => console.error(`spike on http://127.0.0.1:${port}/mcp`));

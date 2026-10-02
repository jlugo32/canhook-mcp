// Drives real MCP tool calls over Streamable HTTP with a real bearer token.
// Usage: node verify/mcp_client.mjs <tool|__list__> <token> [jsonArgs]
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const [, , tool, token, ...rest] = process.argv;
const args = rest.length ? JSON.parse(rest.join(' ')) : {};
const url = new URL(process.env.MCP_URL ?? 'http://127.0.0.1:8790/mcp');

const transport = new StreamableHTTPClientTransport(url, {
  requestInit: { headers: token ? { Authorization: `Bearer ${token}` } : {} },
});
const client = new Client({ name: 'canhook-verify', version: '1.0.0' });

try {
  await client.connect(transport);
  if (tool === '__list__') {
    const r = await client.listTools();
    console.log(JSON.stringify(r.tools.map((t) => t.name)));
  } else {
    const r = await client.callTool({ name: tool, arguments: args });
    console.log(JSON.stringify(r));
  }
  await client.close();
  process.exit(0);
} catch (e) {
  console.log(JSON.stringify({ transport_error: String(e?.message ?? e) }));
  process.exit(2);
}

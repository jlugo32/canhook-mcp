# canhook-mcp

Remote **MCP resource server** for [CanHook](https://canhook.com) — inspect captured
webhooks, diagnose relay delivery failures, replay requests, and manage endpoints
from Claude (or any MCP agent) over an OAuth 2.1 connection.

- **Public URL:** https://canhook.com/mcp
- **Transports:** stdio + Streamable HTTP
- **Auth:** OAuth 2.1 (PKCE). The CanHook PHP app is the authorization server; this
  server validates bearer tokens by introspection.

Design decisions are in [adr/](adr/); the SDK/transport spike is in [docs/spike.md](docs/spike.md).
The companion PHP app is [jlugo32/canhook](https://github.com/jlugo32/canhook).

## Setup

```bash
npm install
cp .env.example .env         # fill in DB (read-only user), INTROSPECTION_SECRET, INTERNAL_API_SECRET
npm run build
```

## Run

```bash
# HTTP (production, reverse-proxied by OLS as https://canhook.com/mcp):
node dist/index.js
# or via PM2:
pm2 start ecosystem.config.cjs

# stdio (local/CLI, single user): set CANHOOK_TOKEN to a valid access token
CANHOOK_TOKEN=<access_token> node dist/index.js --stdio
```

## Deploy

The server is a long-running Node process, not static files. Keep it out of the web
docroot and reverse-proxy `/mcp` to it.

```bash
git pull && npm run build && pm2 reload canhook-mcp
```

## Tools

| Scope | Tools |
|-------|-------|
| `canhook.read` | list_endpoints, get_endpoint, list_requests, get_request, list_relay_rules, list_deliveries, get_delivery, get_usage, **diagnose_endpoint** |
| `canhook.write` | create_endpoint, update_endpoint, create_relay_rule, replay_request, retry_delivery, delete_endpoint |

Write tools and replay route through the CanHook PHP internal API, so the SSRF guard
and plan limits are enforced in one place. `diagnose_endpoint` returns a structured
diagnosis (success rate, failures grouped by plain-language cause, top failing
destinations, primary diagnosis) an agent can explain to the user.

## Verification

`verify/run.sh` drives 12 checks against a live local stack (PHP + Node) — OAuth
discovery, PKCE flow, introspection, read/write tools, scope enforcement, IDOR,
SSRF-through-MCP, diagnose, refresh rotation, unauthenticated rejection, and the
key tripwire.

```bash
npm test               # unit tests (vitest)
npm run conformance    # MCP conformance suite vs conformance-baseline.yml (Node >= 22)
```

## License

MIT — see [LICENSE](LICENSE).

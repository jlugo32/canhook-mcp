# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- `src/contracts/`: host interfaces (repositories, replay, usage, audit log, token introspector, `HostError`), so the MCP layer has no CanHook-specific code.
- `src/adapters/canhook/`: CanHook implementations of the contracts (MariaDB reads, PHP internal API writes, OAuth introspection).
- Vitest suite (63 tests): every tool, ownership (IDOR), scope enforcement, rate limit, HTTP bearer gate, protected-resource metadata, adapter error mapping, and a tools/list snapshot against the pre-extraction baseline.
- `npm run check` (typecheck + tests).
- Step 0 inventory, Step 1 conformance spike and ADR-0001 (TS SDK v2, one dual-era `/mcp` route).

- MCP 2026-07-28 support via TS SDK v2 (`@modelcontextprotocol/server` 2.1.0): stateless per-request serving, `server/discover`, `resultType` on every result, `ttlMs`/`cacheScope: "private"` on `tools/list`, `Mcp-Method`/`Mcp-Name` header validation (-32020), protocol version from `_meta` (-32022 on mismatch). 2025-era clients keep working on the same `/mcp` route (ADR-0001).
- Host and Origin header validation on every route (DNS-rebinding protection).
- Conformance: `npm run conformance` runs the 2026-07-28 requirement set against the real app with `conformance-baseline.yml` (98 checks pass; every failure is baselined with a reason).

### Changed
- Tools are listed in alphabetical order.
- Tool input schemas are JSON Schema 2020-12 (SDK v2). Names, descriptions, annotations and parameters are unchanged.
- `GET /mcp` returns 405: no standalone SSE stream and no sessions.
- `verify/run.sh` takes `CANHOOK=<app dir>` so the end-to-end harness can run against a throwaway app copy and database.

## [1.0.0] - 2026-07-07

### Added
- Remote MCP server with 15 tools (9 read, 6 write), OAuth 2.1 bearer introspection, Streamable HTTP and stdio transports.

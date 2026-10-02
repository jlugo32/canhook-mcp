# ADR-0001: SDK and transport

- Status: Accepted (owner approved 2026-09-27, legacy-removal date confirmed)
- Date: 2026-09-27
- Evidence: [docs/spike.md](../docs/spike.md)

## Context

The live CanHook connector is a Node/TypeScript server built on `@modelcontextprotocol/sdk` 1.29.0. It speaks MCP 2025-11-25.
The owner chose to keep TypeScript and upgrade in place (option A) instead of the PHP rewrite in the original brief.
The target is MCP 2026-07-28: stateless, `server/discover`, `resultType`, cache hints, header validation, MRTR and Tasks.

The brief's decision rule:
- Gaps that can be patched in under a week → fork and send the fixes upstream.
- Larger gaps → two routes: legacy now and stateless later.
- No long-term fork.

## Decision

1. **SDK: move to the TS SDK v2 line.**
   - Packages: `@modelcontextprotocol/server` 2.1.0, `@modelcontextprotocol/node` 2.1.0 and `@modelcontextprotocol/express` 2.0.1.
   - Pin exact versions. v2 is the stable line and implements 2026-07-28.
   - It runs on our current Node 20.
   - No fork.
2. **Transport: one `/mcp` route, stateless Streamable HTTP, built with `createMcpHandler`.**
   - The default `legacy: 'stateless'` serves 2025-era clients per request from the same factory. This replaces the brief's two-route pattern: the SDK already does the dual-era split inside one handler.
   - Legacy `GET` and `DELETE` return 405. No sessions, no SSE resumability, no GET stream.
   - The removal of the legacy leg (switch to `legacy: 'reject'`) is set by ADR-0006. Proposed trigger: legacy traffic stays under 5% of calls for 30 days, and not before 2027-01-28. Owner confirmed this date on 2026-09-27.
3. **MRTR** uses the SDK's `inputRequired(...)`, with `requestState` sealed by `createRequestStateCodec`.
   - The key comes from a shared secret in `.env`, not a per-process random key. Then state survives a PM2 reload and a second replica.
4. **Tasks (SEP-2663) is deferred. It is the one real gap.**
   - No released TS SDK has it (open PR #2782). Hand-written handlers are blocked by issue #2598.
   - `canhook_bulk_replay` ships first with a server-minted handle, `<user_id>:<handle>`-bound, and a read tool to poll status and cancel.
   - When a release includes the Tasks extension, we wrap it with no change to the handle model.
   - Our upstream contribution: test PR #2782 against our bulk replay and the conformance tasks scenarios, and report the results on the PR.
5. **Conformance** runs with `@modelcontextprotocol/conformance` pinned to 0.2.0-alpha.11 (or newer) on Node 22 in CI.
   - The stable 0.1.16 has no 2026-07-28 scenarios.
   - A separate fixture entry registers the suite's sample tools. It is never mounted on production `/mcp`.
   - `conformance-baseline.yml` lists today's expected failures: the Tasks gap and the x-mcp-header n/a scenarios.

## Consequences

- Good: the SDK already passes stateless, discover, caching, header-validation, version-error and MRTR checks. Our work goes into tools, auth and product, not protocol plumbing.
- Good: current Claude and Cursor users keep working through the cutover.
- Cost: the v1 → v2 migration touches `server.ts` and every tool registration (Zod v4 `z.object` schemas, new handler context). The 15 tools are small, so this is contained.
- Cost: bulk replay has no Tasks-extension wrapper until upstream ships it. Clients poll with a normal tool instead.
- Risk: v2.1.0 is 4 days old. Mitigation: pin exact versions, keep the conformance baseline in CI, and keep the v1 build tagged for rollback (`git tag pre-v2`).
- The brief's "PHP SDK upstream PRs" goal is dropped with option A. The upstream goal moves to the TS SDK Tasks PR and the conformance tool.

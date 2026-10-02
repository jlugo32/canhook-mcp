# Step 1 — Conformance spike (2026-09-27)

Goal: find out whether an official SDK can serve MCP 2026-07-28 today, and what is missing.
Decision is in [ADR-0001](../adr/ADR-0001-sdk-and-transport.md).

## Setup

| Item | Value |
|---|---|
| SDK | `@modelcontextprotocol/server` 2.1.0 (stable v2 line, released 2026-09-23), `@modelcontextprotocol/node` 2.1.0, `@modelcontextprotocol/express` 2.0.1 |
| Runtime | Node 20.20.2 (SDK `engines: >=20`, so production Node does not change) |
| Conformance tool | `@modelcontextprotocol/conformance@0.2.0-alpha.11` — the stable 0.1.16 has **no** 2026-07-28 scenarios, and it needs Node ≥22 (`fs.globSync`); ran it from a portable Node 22.23.3 |
| Spike server | [`spike/server.ts`](../spike/server.ts): `createMcpHandler` on Express, 2 tools (read with `outputSchema`; delete with MRTR), 1 resource template, 1 prompt, `cacheHints` with `cacheScope: "private"`. Fake in-memory data. |

Commands:

```bash
npx tsx spike/server.ts                      # listens on 127.0.0.1:8799/mcp
npx @modelcontextprotocol/conformance@0.2.0-alpha.11 server \
  --url http://127.0.0.1:8799/mcp --spec-version 2026-07-28
npx @modelcontextprotocol/conformance@0.2.0-alpha.11 server \
  --url http://127.0.0.1:8799/mcp --scenario <name>   # for scenarios outside the active suite
python3 spike/mrtr_roundtrip.py              # manual MRTR round trip
```

## Results

Each failure is sorted into one of three groups:

- **fixture**: the scenario calls a sample tool the suite expects (`test_simple_text`, `slow_compute`, …). Our server does not have them. This is not a spec gap.
- **n/a**: a feature we do not use (x-mcp-header custom headers).
- **gap**: something real is missing.

### Active suite, `--spec-version 2026-07-28`: 25 pass, 15 fail

All 15 failures are **fixture** failures. `WireSchemaValid` passed on every scenario. Passed outright: tools-list, resources-list, prompts-list, server-sse-multiple-streams, dns-rebinding-protection.

### 2026-07-28 scenarios run one at a time

| Scenario | Pass | Fail | Failure kind |
|---|---|---|---|
| server-stateless | 24 | 4 | fixture (`test_missing_capability`, `test_streaming_elicitation`, `test_logging_tool`) |
| caching (ttlMs / cacheScope) | 7 | 0 | — |
| http-header-validation (Mcp-Method / Mcp-Name) | 14 | 0 | — |
| http-custom-header-server-validation | 1 | 5 | n/a (no x-mcp-header tools) |
| sep-2164-resource-not-found | 4 | 0 | — |
| input-required-result-* (11 scenarios) | 13 | 8 | fixture (`test_input_required_result_*`) |
| tasks-capability-negotiation | 1 | 4 | **gap** (+ fixture) |
| tasks-lifecycle | 1 | 8 | **gap** (+ fixture) |

What passed and matters to us:

- Stateless lifecycle: `initialize`, `ping`, `logging/setLevel`, `resources/subscribe` → 404 + -32601.
- `server/discover` is served. serverInfo is in the result `_meta`. The capabilities match the handlers.
- Missing `_meta`, `protocolVersion` or `clientCapabilities` → 400 + -32602.
- Unknown version → 400 + -32022 with the supported list. Header/body mismatch → 400 + -32020.
- Cache hints are sent to 2026-era clients only.

### Manual MRTR check on our own tool (`canhook_delete_endpoint`)

```
R1 resultType: input_required | msg: Delete "stripe-prod"? 42 captured requests will be lost.
R2: complete  [Deleted stripe-prod (spike: nothing really deleted, era=modern)]
R3 tampered: {'code': -32602, 'message': 'Invalid or expired requestState', 'data': {'reason': 'invalid_request_state'}}
```

`requestState` is HMAC-sealed with the SDK's `createRequestStateCodec` (600 s TTL).
In production the key must be a shared secret. A per-process key breaks after a PM2 reload or with 2 replicas.

### Legacy (2025-11-25) client on the same `/mcp` route

`initialize` returns `protocolVersion: 2025-11-25`, and `tools/list` works. No `ttlMs` is added for legacy clients, which is correct.
So one route serves both eras (`createMcpHandler` default `legacy: 'stateless'`).
Today's server already runs with `sessionIdGenerator: undefined`, so current clients lose no session state.

## Gaps: candidate upstream work

1. **Tasks extension (SEP-2663) is not in any released TS SDK.**
   - Open PR [typescript-sdk#2782](https://github.com/modelcontextprotocol/typescript-sdk/pull/2782) "Tasks extension for server and client (ext/tasks subpaths)".
   - Open issue [#2598](https://github.com/modelcontextprotocol/typescript-sdk/issues/2598): custom `tasks/get` / `tasks/cancel` handlers get -32601 before the handler lookup runs. So we also cannot write Tasks by hand on 2.1.0.
   - Conformance shows this: `capabilities.extensions MUST be advertised`, and `tasks/get MUST return -32021; got -32601`.
   - Upstream contribution candidate: run PR #2782 against `canhook_bulk_replay` and the conformance tasks scenarios, then post the results and any fixes on the PR. Add a failing test to #2598.
2. **Conformance tool:** the stable release (0.1.16) has no 2026-07-28 scenarios, and its `engines` does not state the Node ≥22 need. It crashes on Node 20 with `fs does not export globSync`. This is a small docs/engines PR candidate for modelcontextprotocol/conformance.
3. **Fixture tools:** to get a clean baseline, the conformance run needs the suite's sample tools. Plan: a separate `conformance-fixture` server entry that registers them. It must not be on the production `/mcp`. The production server is then checked by the scenarios that need no fixtures, plus our own tests.

## Not tested in the spike

- OAuth / CIMD / step-up scopes. The client auth scenarios (`auth/basic-cimd`, `auth/scope-step-up`) test clients, not servers. Server-side auth is tested in our own suite (Step 8).
- OpenLiteSpeed proxy behaviour for the new headers. Checked at deploy time.

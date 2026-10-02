import type { Deps } from '../contracts/index.js';

/** OAuth scopes this server understands. */
export const SCOPES = { read: 'canhook.read', write: 'canhook.write' } as const;

/** Per-request identity derived from token introspection. Never trusted from client input. */
export type Ctx = { userId: number; scopes: string[] };

/** Everything a tool handler needs: the caller, the host contracts, and tuning. */
export type ToolEnv = { ctx: Ctx; deps: Deps; rateLimitPerMin: number };

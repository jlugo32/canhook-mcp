import mysql from 'mysql2/promise';
import type { AuditLog, Deps } from '../../contracts/index.js';
import { createInternalApi } from './internal-api.js';
import { createIntrospector } from './introspection.js';
import { createReadQueries } from './mysql.js';

export interface CanHookAdapterOptions {
  db: { host: string; database: string; user: string; password: string };
  introspection: { url: string; secret: string; cacheTtlMs: number };
  internalApi: { baseUrl: string; hostHeader: string; secret: string };
  audit?: AuditLog;
}

/** Records nothing. Replaced by the MariaDB-backed audit log in Step 8. */
export const noopAuditLog: AuditLog = { record: async () => {} };

/**
 * Wire the CanHook implementations of every contract.
 * Reads: SELECT-only MariaDB pool. Writes and outbound: PHP internal API.
 */
export function createCanHookDeps(opts: CanHookAdapterOptions): Deps {
  const pool = mysql.createPool({ ...opts.db, connectionLimit: 5, namedPlaceholders: false });
  const q = createReadQueries(pool);
  const call = createInternalApi(opts.internalApi);

  return {
    endpoints: {
      list: (u) => q.listEndpoints(u),
      get: (u, ref) => q.getEndpoint(u, ref),
      exists: (u, ref) => q.endpointExists(u, ref),
      create: (u, input) => call(u, 'POST', '/endpoints', input),
      update: (u, ref, patch) => call(u, 'PATCH', `/endpoints/${encodeURIComponent(ref)}`, patch),
      delete: (u, ref) => call(u, 'DELETE', `/endpoints/${encodeURIComponent(ref)}`, undefined),
    },
    requests: {
      list: (u, ref, o) => q.listRequests(u, ref, o),
      get: (u, id) => q.getRequest(u, id),
    },
    relayRules: {
      list: (u, ref) => q.listRelayRules(u, ref),
      create: (u, input) => call(u, 'POST', '/relay-rules', input),
    },
    deliveries: {
      list: (u, o) => q.listDeliveries(u, o),
      get: (u, id) => q.getDelivery(u, id),
      diagnoseRows: (u, ref, h) => q.diagnoseRows(u, ref, h),
      retry: (u, id) => call(u, 'POST', `/deliveries/${id}/retry`, {}),
    },
    replay: {
      replay: (u, input) => call(u, 'POST', '/replay', input),
    },
    usage: {
      get: (u) => q.getUsage(u),
    },
    audit: opts.audit ?? noopAuditLog,
    introspector: createIntrospector(opts.introspection),
  };
}

import type { Pool, RowDataPacket } from 'mysql2/promise';
import type {
  DiagnoseRow, EndpointRef, ListDeliveriesOptions, ListRequestsOptions, Row, Usage,
} from '../../contracts/index.js';

/**
 * The ONE place read SQL lives — the single auditable module for IDOR review.
 *
 * INVARIANT: every query takes `userId` as its REQUIRED first parameter and bakes
 * the owner scope into the SQL (WHERE user_id = ? or the correct ownership-chain
 * join). The pool's DB user is SELECT-only, so even a buggy query cannot mutate.
 * Writes go through the PHP internal API (see internal-api.ts).
 */
export function createReadQueries(pool: Pool) {
  async function q(sql: string, params: unknown[]): Promise<Row[]> {
    const [rows] = await pool.query<RowDataPacket[]>(sql, params);
    return rows as Row[];
  }
  const idOf = (ref: EndpointRef) => Number(ref) || 0;

  return {
    listEndpoints(userId: number) {
      return q(
        `SELECT id, token, name, is_active, created_at,
            (SELECT COUNT(*) FROM requests r WHERE r.endpoint_id = e.id) AS request_count
         FROM endpoints e WHERE e.user_id = ? ORDER BY e.created_at DESC`,
        [userId],
      );
    },

    async getEndpoint(userId: number, ref: EndpointRef) {
      const rows = await q(
        `SELECT e.*, (SELECT COUNT(*) FROM relay_rules rr WHERE rr.endpoint_id = e.id) AS rule_count
         FROM endpoints e WHERE e.user_id = ? AND (e.token = ? OR e.id = ?) LIMIT 1`,
        [userId, ref, idOf(ref)],
      );
      return rows[0] ?? null;
    },

    async endpointExists(userId: number, ref: EndpointRef) {
      const rows = await q(
        `SELECT 1 FROM endpoints WHERE user_id = ? AND (token = ? OR id = ?) LIMIT 1`,
        [userId, ref, idOf(ref)],
      );
      return rows.length > 0;
    },

    listRequests(userId: number, ref: EndpointRef, opts: ListRequestsOptions) {
      const params: unknown[] = [userId, ref, idOf(ref)];
      let sql = `SELECT r.id, r.method, r.content_type, r.size_bytes, r.source_ip, r.received_at, LEFT(r.body, 400) AS body_preview
        FROM requests r JOIN endpoints e ON e.id = r.endpoint_id
        WHERE e.user_id = ? AND (e.token = ? OR e.id = ?)`;
      if (opts.method) { sql += ' AND r.method = ?'; params.push(opts.method.toUpperCase()); }
      if (opts.contains) { sql += ' AND r.body LIKE ?'; params.push('%' + opts.contains + '%'); }
      if (opts.since) { sql += ' AND r.id > ?'; params.push(opts.since); }
      sql += ' ORDER BY r.received_at DESC, r.id DESC LIMIT ?';
      params.push(opts.limit);
      return q(sql, params);
    },

    async getRequest(userId: number, requestId: number) {
      // Ownership chain: request → endpoint → user.
      const rows = await q(
        `SELECT r.* FROM requests r JOIN endpoints e ON e.id = r.endpoint_id
         WHERE r.id = ? AND e.user_id = ? LIMIT 1`,
        [requestId, userId],
      );
      return rows[0] ?? null;
    },

    listRelayRules(userId: number, ref: EndpointRef) {
      return q(
        `SELECT rr.id, rr.name, rr.destination_url, rr.transform_mode, rr.is_active, rr.retry_count
         FROM relay_rules rr JOIN endpoints e ON e.id = rr.endpoint_id
         WHERE e.user_id = ? AND (e.token = ? OR e.id = ?)`,
        [userId, ref, idOf(ref)],
      );
    },

    listDeliveries(userId: number, opts: ListDeliveriesOptions) {
      const params: unknown[] = [userId];
      let sql = `SELECT d.id, d.relay_rule_id, d.request_id, d.attempt, d.status, d.response_status, d.duration_ms, d.error, d.delivered_at, d.next_attempt_at
        FROM relay_deliveries d JOIN relay_rules rr ON rr.id = d.relay_rule_id JOIN endpoints e ON e.id = rr.endpoint_id
        WHERE e.user_id = ?`;
      if (opts.ruleId) { sql += ' AND d.relay_rule_id = ?'; params.push(opts.ruleId); }
      if (opts.endpoint) { sql += ' AND (e.token = ? OR e.id = ?)'; params.push(opts.endpoint, idOf(opts.endpoint)); }
      if (opts.status) { sql += ' AND d.status = ?'; params.push(opts.status); }
      sql += ' ORDER BY d.id DESC LIMIT ?';
      params.push(opts.limit);
      return q(sql, params);
    },

    async getDelivery(userId: number, deliveryId: number) {
      // Ownership chain: delivery → rule → endpoint → user.
      const rows = await q(
        `SELECT d.* FROM relay_deliveries d JOIN relay_rules rr ON rr.id = d.relay_rule_id
         JOIN endpoints e ON e.id = rr.endpoint_id WHERE d.id = ? AND e.user_id = ? LIMIT 1`,
        [deliveryId, userId],
      );
      return rows[0] ?? null;
    },

    /** Read-only aggregation source for diagnose_endpoint. Ownership enforced via the endpoint join. */
    async diagnoseRows(userId: number, ref: EndpointRef, hours: number): Promise<DiagnoseRow[]> {
      const rows = await q(
        `SELECT d.status, d.response_status, d.error, rr.destination_url, d.delivered_at, d.next_attempt_at, d.created_at
         FROM relay_deliveries d JOIN relay_rules rr ON rr.id = d.relay_rule_id JOIN endpoints e ON e.id = rr.endpoint_id
         WHERE e.user_id = ? AND (e.token = ? OR e.id = ?) AND d.created_at > (NOW() - INTERVAL ? HOUR)`,
        [userId, ref, idOf(ref), hours],
      );
      return rows as unknown as DiagnoseRow[];
    },

    async getUsage(userId: number): Promise<Usage> {
      const u = (await q(`SELECT plan FROM users WHERE id = ?`, [userId]))[0] as { plan?: string } | undefined;
      const eps = (await q(`SELECT COUNT(*) AS c FROM endpoints WHERE user_id = ?`, [userId]))[0] as { c: number };
      const today = ((await q(
        `SELECT captures_count, relay_count FROM api_usage WHERE user_id = ? AND day = CURDATE()`,
        [userId],
      ))[0] as { captures_count?: number; relay_count?: number } | undefined) ?? {};
      return {
        plan: u?.plan ?? 'free',
        endpoints_used: eps.c,
        captures_today: today.captures_count ?? 0,
        relay_today: today.relay_count ?? 0,
      };
    },
  };
}

export type ReadQueries = ReturnType<typeof createReadQueries>;

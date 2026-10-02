/**
 * Contracts between the MCP layer and the host application.
 *
 * The MCP layer (server, tools, auth gates) depends ONLY on these interfaces.
 * The CanHook app supplies the implementations in `src/adapters/canhook/`.
 * Nothing in this file knows about MariaDB, the PHP internal API, or secrets.
 *
 * INVARIANT (IDOR): every method takes `userId` as its first parameter and an
 * implementation MUST scope its result to that owner. A method that returns
 * another user's row is a security bug in the adapter, not in the caller.
 *
 * `EndpointRef` is an endpoint token or a numeric id, as the user typed it.
 */

export type EndpointRef = string;
export type Row = Record<string, unknown>;

export interface ListRequestsOptions {
  method?: string;
  since?: number;
  contains?: string;
  limit: number;
}

export interface ListDeliveriesOptions {
  endpoint?: EndpointRef;
  ruleId?: number;
  status?: string;
  limit: number;
}

export interface DiagnoseRow {
  status: string;
  response_status: number | null;
  error: string | null;
  destination_url: string;
}

export interface Usage {
  plan: string;
  endpoints_used: number;
  captures_today: number;
  relay_today: number;
}

export interface EndpointRepository {
  list(userId: number): Promise<Row[]>;
  get(userId: number, ref: EndpointRef): Promise<Row | null>;
  exists(userId: number, ref: EndpointRef): Promise<boolean>;
  create(userId: number, input: { name: string; description?: string }): Promise<unknown>;
  update(userId: number, ref: EndpointRef, patch: Record<string, unknown>): Promise<unknown>;
  delete(userId: number, ref: EndpointRef): Promise<unknown>;
}

export interface RequestRepository {
  list(userId: number, ref: EndpointRef, opts: ListRequestsOptions): Promise<Row[]>;
  get(userId: number, requestId: number): Promise<Row | null>;
}

export interface RelayRuleRepository {
  list(userId: number, ref: EndpointRef): Promise<Row[]>;
  /** The implementation MUST validate the destination (SSRF guard) before saving. */
  create(userId: number, input: Record<string, unknown>): Promise<unknown>;
}

export interface DeliveryRepository {
  list(userId: number, opts: ListDeliveriesOptions): Promise<Row[]>;
  get(userId: number, deliveryId: number): Promise<Row | null>;
  diagnoseRows(userId: number, ref: EndpointRef, hours: number): Promise<DiagnoseRow[]>;
  retry(userId: number, deliveryId: number): Promise<unknown>;
}

export interface ReplayService {
  /** The implementation MUST validate the destination (SSRF guard) before any outbound call. */
  replay(userId: number, input: { request_id: number; destination_url: string }): Promise<unknown>;
}

export interface UsageService {
  get(userId: number): Promise<Usage>;
}

export interface AuditEntry {
  at: string;
  userId: number;
  clientId?: string;
  tool: string;
  arguments: Record<string, unknown>;
  confirmation?: 'confirmed' | 'declined' | 'fallback_confirm_flag' | 'not_required';
  resultHash?: string;
  correlationId: string;
  isError: boolean;
}

export interface AuditLog {
  record(entry: AuditEntry): Promise<void>;
}

export interface Introspection {
  active: boolean;
  userId?: number;
  scopes: string[];
  clientId?: string;
  audience?: string[];
  expiresAt?: number;
}

export interface TokenIntrospector {
  introspect(token: string): Promise<Introspection>;
}

/**
 * A host-side failure the agent should see as-is (plan limit, SSRF block, …).
 * `message` must already be safe and actionable for an end user.
 */
export class HostError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'HostError';
  }
}

/** Everything the MCP layer needs from the host, injected once at startup. */
export interface Deps {
  endpoints: EndpointRepository;
  requests: RequestRepository;
  relayRules: RelayRuleRepository;
  deliveries: DeliveryRepository;
  replay: ReplayService;
  usage: UsageService;
  audit: AuditLog;
  introspector: TokenIntrospector;
}

import 'dotenv/config';

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env: ${name}`);
  return v;
}

const base = process.env.CANHOOK_BASE_URL ?? 'https://canhook.com';

// The PHP /internal/* write API rejects any non-loopback caller with 404 BEFORE
// the secret check, so it must be reached over loopback (INTERNAL_API_BASE_URL,
// e.g. http://127.0.0.1) — never via the public base, which egresses through
// OpenLiteSpeed and arrives with the server's public IP. OLS routes vhosts by
// Host header, so internal requests still carry the public host name.
const internalOrigin = process.env.INTERNAL_API_BASE_URL ?? base;

export const CONFIG = {
  baseUrl: base,
  issuer: process.env.OAUTH_ISSUER ?? base,
  host: process.env.MCP_HOST ?? '127.0.0.1',
  port: Number(process.env.MCP_PORT ?? 8790),
  db: {
    host: process.env.DB_HOST ?? '127.0.0.1',
    database: req('DB_NAME'),
    user: req('DB_USER'),
    password: req('DB_PASS'),
  },
  introspectionUrl: base + '/oauth/introspect',
  introspectionSecret: req('INTROSPECTION_SECRET'),
  internalBase: internalOrigin + '/internal',
  internalHostHeader: new URL(base).host,
  internalSecret: req('INTERNAL_API_SECRET'),
  introspectCacheTtlMs: Number(process.env.INTROSPECT_CACHE_TTL_MS ?? 60000),
  rateLimitPerMin: Number(process.env.RATE_LIMIT_PER_MIN ?? 120),
  serverName: 'canhook',
  serverVersion: '1.0.0',
} as const;

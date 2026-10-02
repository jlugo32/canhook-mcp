import { CONFIG } from './config.js';
import { createCanHookDeps } from './adapters/canhook/index.js';
import type { ServerOptions } from './server.js';

/** Composition root: the only module that reads env config and picks the CanHook adapter. */
const opts: ServerOptions = {
  deps: createCanHookDeps({
    db: CONFIG.db,
    introspection: { url: CONFIG.introspectionUrl, secret: CONFIG.introspectionSecret, cacheTtlMs: CONFIG.introspectCacheTtlMs },
    internalApi: { baseUrl: CONFIG.internalBase, hostHeader: CONFIG.internalHostHeader, secret: CONFIG.internalSecret },
  }),
  baseUrl: CONFIG.baseUrl,
  issuer: CONFIG.issuer,
  rateLimitPerMin: CONFIG.rateLimitPerMin,
  name: CONFIG.serverName,
  version: CONFIG.serverVersion,
};

/** Transport selection: --stdio for local/CLI, otherwise Streamable HTTP. */
const { runHttp, runStdio } = await import('./server.js');
if (process.argv.includes('--stdio')) {
  await runStdio(opts, process.env.CANHOOK_TOKEN ?? '');
} else {
  runHttp(opts, CONFIG.port, CONFIG.host);
}

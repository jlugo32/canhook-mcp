/**
 * LOCAL-ONLY conformance target. Serves the real /mcp app (real SDK wiring,
 * real tools, real bearer gate) over in-memory fake data, and injects a test
 * bearer token because the conformance runner cannot authenticate.
 *
 * Never import this from src/. Binds 127.0.0.1 only.
 *   npx tsx scripts/conformance-server.ts            # port 8797
 */
import express from 'express';
import { createHttpApp } from '../src/server.js';
import { fakeDeps } from '../tests/support/fakes.js';

const port = Number(process.env.PORT ?? 8797);
const mcp = createHttpApp({
  deps: fakeDeps(),
  baseUrl: `http://127.0.0.1:${port}`,
  issuer: `http://127.0.0.1:${port}`,
  rateLimitPerMin: 100_000,
  name: 'canhook',
  version: 'conformance',
});
const outer = express();
outer.use((req, _res, next) => {
  if (!req.headers.authorization) req.headers.authorization = 'Bearer tok-rw';
  next();
});
outer.use(mcp);
outer.listen(port, '127.0.0.1', () => console.error(`conformance target on http://127.0.0.1:${port}/mcp`));

/**
 * App assembly — `createApp(deps)` returns a configured Hono instance without
 * binding a port (so it is unit-testable via `app.request(...)`). The serve
 * command owns the actual `@hono/node-server` listen + lifecycle.
 *
 * Request pipeline: security (Host/Origin) → `/api` routes → static `web/`.
 */

import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { relative } from 'node:path';
import { createSecurityMiddleware } from './security.js';
import { createApiRoutes } from './routes.js';
import type { RouteDeps } from './routes.js';

export interface AppDeps extends RouteDeps {
  /** Port the server will bind (for Host/Origin validation). */
  port: number;
  /** Absolute path to the static `web/` root to serve. */
  webRoot: string;
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  // DNS-rebinding / CSRF defence on every request (design §7).
  app.use('*', createSecurityMiddleware({ port: deps.port }));

  // REST + SSE API.
  app.route('/api', createApiRoutes(deps));

  // Static front-end (zero-build). serveStatic resolves `root` relative to cwd,
  // so convert the absolute webRoot into a cwd-relative path (SEC-04: hono's
  // audited serveStatic, never hand-rolled path joining).
  const relWebRoot = relative(process.cwd(), deps.webRoot) || '.';
  app.use('*', serveStatic({ root: relWebRoot, index: 'index.html' }));

  return app;
}

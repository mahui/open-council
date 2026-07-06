/**
 * `council serve` — launch the local Web GUI (design-notes/web-gui-design.md).
 *
 * Thin command (ARCH-03): assemble deps (adapter / models / store) via the
 * shared assembly helpers, hand them to `src/server` which owns all HTTP logic,
 * bind loopback, print the URL to stderr, and open the browser. Progress goes to
 * stderr; the server never writes to stdout.
 */

import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { serve } from '@hono/node-server';
import { PATHS } from '../config/paths.js';
import { resolveResourceRoot } from '../shared/resources.js';
import { ConfigLoader } from '../config/loader.js';
import { SessionStore } from '../storage/session-store.js';
import { createApp } from '../server/app.js';
import { DebateManager } from '../server/debate-manager.js';
import { RuntimeConfig } from '../server/runtime-config.js';
import { discoverCredentials, buildAdapter, resolveModels } from './shared/assemble.js';

const DEFAULT_PORT = 3720;
const HOST = '127.0.0.1';

interface ServeOptions {
  port?: string;
  open?: boolean; // commander sets `open: false` for --no-open
}

export async function runServe(options: ServeOptions): Promise<void> {
  const port = parsePort(options.port);

  // Assemble orchestration deps (server-side only; credentials never leave here).
  const credentialManager = await discoverCredentials();
  const { models, chairman, roleGenModel, minAgents, maxAgents, prefer } = resolveModels({ loadGeneralConfig: true });
  if (models.length === 0) {
    process.stderr.write(
      'Error: No models available. Run "council setup" or set API keys ' +
        '(ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY).\n',
    );
    process.exit(1);
  }

  const store = new SessionStore(PATHS.sessionsDir);
  const loader = new ConfigLoader();

  // Live config holder; GUI config writes call reloadRuntime() to swap it (design §5).
  const runtime = new RuntimeConfig({
    adapter: buildAdapter(),
    models,
    allModels: loader.loadAllModelConfigs(),
    defaultChairman: chairman ?? '',
    roleGenModel,
    minAgents: minAgents ?? 2,
    maxAgents: maxAgents ?? 5,
    preferOrder: prefer ?? [],
  });
  const manager = new DebateManager({ runtime, store, loadRoleSet: (name) => loader.loadRoleSet(name) });

  const webRoot = resolveWebRoot();
  const app = createApp({ manager, store, runtime, loader, credentialManager, port, webRoot });

  const server = serve({ fetch: app.fetch, port, hostname: HOST }, () => {
    const url = `http://localhost:${port}`;
    process.stderr.write(
      process.stderr.isTTY
        ? `\n\x1b[1m🏛️  Open Council\x1b[0m running at \x1b[36m${url}\x1b[0m\n` +
            `   \x1b[2mPress Ctrl+C to stop.\x1b[0m\n\n`
        : `Open Council running at ${url}\n`,
    );
    if (options.open !== false) openBrowser(url);
  });

  // serve() binds asynchronously; without a listener a bind failure (e.g.
  // EADDRINUSE) surfaces as an unhandled 'error' event and a raw stack trace.
  server.on('error', (err) => {
    const e = err as NodeJS.ErrnoException;
    process.stderr.write(
      e.code === 'EADDRINUSE'
        ? `Error: 端口 ${port} 已被占用。换用 "council serve --port <其它端口>" 或释放该端口。\n`
        : `Error: 服务启动失败: ${e.message}\n`,
    );
    process.exit(1);
  });

  // Graceful shutdown: release the SQLite connection (design §7).
  const shutdown = (): void => {
    server.close(() => {
      store.close();
      process.exit(0);
    });
    // Safety net if close hangs.
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/**
 * Resolve the bundled `web/` static root. `web/` ships at the package root in
 * every layout (dev repo, built dist, npm install), so defer to the shared
 * resource-root resolver, which walks up to the package root regardless of the
 * caller's module depth. See {@link resolveResourceRoot}.
 */
export function resolveWebRoot(dirname: string = import.meta.dirname): string {
  return join(resolveResourceRoot(dirname), 'web');
}

/** Validate a --port string; returns the port or null when out of range. Pure. */
export function validatePort(raw: string | undefined): number | null {
  if (raw === undefined) return DEFAULT_PORT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return null;
  return n;
}

/** Map the platform to its default browser-open command. Pure. */
export function browserOpenCommand(platform: NodeJS.Platform): string {
  if (platform === 'darwin') return 'open';
  if (platform === 'win32') return 'start';
  return 'xdg-open';
}

/** Parse and validate the --port option, exiting on invalid input. */
function parsePort(raw: string | undefined): number {
  const port = validatePort(raw);
  if (port === null) {
    process.stderr.write(`Error: invalid port "${raw}" (must be 1–65535).\n`);
    process.exit(1);
  }
  return port;
}

/**
 * Best-effort open the default browser. spawn failures degrade silently — the
 * URL is already printed to stderr, so the user can open it manually.
 */
function openBrowser(url: string): void {
  const command = browserOpenCommand(process.platform);
  try {
    const child = spawn(command, [url], {
      stdio: 'ignore',
      detached: true,
      shell: process.platform === 'win32',
    });
    child.on('error', () => {
      /* silent: URL already printed */
    });
    child.unref();
  } catch {
    /* silent: URL already printed */
  }
}

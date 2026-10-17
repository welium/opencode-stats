/**
 * Development launcher.
 *
 * Forwards `--host`/`--port` to the browser-facing Vite listener and keeps the
 * API listener on loopback behind Vite's `/api` proxy (§5). The same invocation
 * pattern as production works:
 *
 *   npm run dev -- --host 0.0.0.0
 */

import { resolve } from 'node:path';
import { createServer as createViteServer } from 'vite';

import { DEFAULT_PORT, formatAddress } from '../src/server/cli.ts';
import { createDatabaseAdapter, resolveDatabasePath } from '../src/server/database.ts';
import { createDashboardServer } from '../src/server/http.ts';
import { defaultStaticRoot } from '../src/server/static.ts';

const DEFAULT_DEV_PORT = 5173;
const projectRoot = resolve(import.meta.dirname, '..');

interface DevOptions {
  host: string;
  port: number;
  apiPort: number;
  db: string | undefined;
}

type DevParseResult = { kind: 'options'; options: DevOptions } | { kind: 'error'; message: string };

function usage(): string {
  return [
    `Usage: npm run dev -- [--host <address>] [--port <number>] [--api-port <number>] [--db <path>]`,
    '',
    `  --host      Address for the browser-facing Vite listener (default: 127.0.0.1).`,
    `  --port      Port for the browser-facing Vite listener (default: ${String(DEFAULT_DEV_PORT)}).`,
    `  --api-port  Port for the loopback API listener behind Vite's proxy (default: ${String(DEFAULT_PORT)}).`,
    `  --db        OpenCode SQLite database to read (same resolution order as the server).`,
  ].join('\n');
}

function parsePort(flag: string, value: string): { port: number } | { error: string } {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    return { error: `${flag} must be an integer between 0 and 65535 (received: ${value})` };
  }
  return { port };
}

function parseArgs(argv: readonly string[]): DevParseResult {
  const options: DevOptions = { host: '127.0.0.1', port: DEFAULT_DEV_PORT, apiPort: DEFAULT_PORT, db: undefined };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] ?? '';
    if (flag === '--help') return { kind: 'error', message: usage() };
    if (flag !== '--host' && flag !== '--port' && flag !== '--api-port' && flag !== '--db') {
      return { kind: 'error', message: `Unknown argument: ${flag}` };
    }

    const value = argv[index + 1];
    if (value === undefined || value === '') return { kind: 'error', message: `Missing value for ${flag}` };
    index += 1;

    if (flag === '--host') options.host = value;
    else if (flag === '--db') options.db = value;
    else {
      const parsed = parsePort(flag, value);
      if ('error' in parsed) return { kind: 'error', message: parsed.error };
      if (flag === '--port') options.port = parsed.port;
      else options.apiPort = parsed.port;
    }
  }

  if (options.host.trim() === '') return { kind: 'error', message: '--host must not be empty' };
  return { kind: 'options', options };
}

async function listenApi(server: ReturnType<typeof createDashboardServer>, port: number): Promise<void> {
  await new Promise<void>((resolveListening, rejectListening) => {
    const onError = (error: Error): void => rejectListening(error);
    server.once('error', onError);
    server.listen({ host: '127.0.0.1', port }, () => {
      server.off('error', onError);
      resolveListening();
    });
  });
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.kind === 'error') {
    process.stderr.write(`${parsed.message}\n`);
    return 2;
  }

  const { host, port, apiPort, db } = parsed.options;
  const resolved = resolveDatabasePath({ explicitDb: db });
  const database = createDatabaseAdapter({ path: resolved.path, pathSource: resolved.source });
  const apiServer = createDashboardServer({ database, staticRoot: defaultStaticRoot(projectRoot) });

  try {
    await listenApi(apiServer, apiPort);
  } catch (error) {
    process.stderr.write(
      `Cannot start the API listener on 127.0.0.1:${String(apiPort)}: ${(error as Error).message}\n`,
    );
    database.close();
    return 1;
  }

  const apiOrigin = `http://127.0.0.1:${String(apiPort)}`;
  let vite: Awaited<ReturnType<typeof createViteServer>> | undefined;
  try {
    vite = await createViteServer({
      root: projectRoot,
      server: {
        host,
        port,
        strictPort: true,
        proxy: { '/api': { target: apiOrigin, changeOrigin: false } },
      },
    });
    await vite.listen();
  } catch (error) {
    process.stderr.write(`Cannot start the Vite development listener on ${host}:${String(port)}: ${(error as Error).message}\n`);
    // A failed listen still owns Vite watchers; close them so startup failure exits.
    await vite?.close();
    apiServer.close();
    database.close();
    return 1;
  }

  process.stdout.write(`API server listening on ${apiOrigin} (proxied at /api, read-only database)\n`);
  process.stdout.write(`Database: ${resolved.path} (${resolved.source}, read-only)\n`);
  process.stdout.write(`Dashboard: ${formatAddress(host, port)}\n`);
  const developmentServer = vite;

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write(`Received ${signal}, shutting down.\n`);
    void developmentServer.close().then(() => {
      apiServer.close(() => {
        database.close();
        process.exit(0);
      });
      apiServer.closeIdleConnections();
    });
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return 0;
}

process.exitCode = await main();

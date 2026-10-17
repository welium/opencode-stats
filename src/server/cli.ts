/**
 * Command-line interface for the dashboard server.
 *
 * Plan references: §5. Defaults to loopback; an explicitly selected host
 * (private address, `0.0.0.0`, `::`) is used exactly as given, with no second
 * opt-in flag, no substitution, and no exposure warning. Port conflicts fail
 * clearly instead of silently changing ports. No `--open`.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Server } from 'node:http';

import { DATABASE_FILE_NAME, createDatabaseAdapter, resolveDatabasePath } from './database.ts';
import { createDashboardServer } from './http.ts';
import { defaultStaticRoot } from './static.ts';

export const PROGRAM_NAME = 'opencode-stats-dashboard';
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 3848;

export interface CliOptions {
  host: string;
  port: number;
  db: string | undefined;
  help: boolean;
  version: boolean;
}

export type CliParseResult = { kind: 'options'; options: CliOptions } | { kind: 'error'; message: string };

const VERSION_FLAGS = new Set(['--version']);
const HELP_FLAGS = new Set(['--help']);
const VALUE_FLAGS = new Set(['--host', '--port', '--db']);

export function parseCliArgs(argv: readonly string[]): CliParseResult {
  const options: CliOptions = {
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    db: undefined,
    help: false,
    version: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? '';

    if (HELP_FLAGS.has(argument)) {
      options.help = true;
      continue;
    }
    if (VERSION_FLAGS.has(argument)) {
      options.version = true;
      continue;
    }

    const equalsIndex = argument.startsWith('--') ? argument.indexOf('=') : -1;
    const flag = equalsIndex === -1 ? argument : argument.slice(0, equalsIndex);
    if (!VALUE_FLAGS.has(flag)) {
      return { kind: 'error', message: `Unknown argument: ${argument}` };
    }

    const value = equalsIndex === -1 ? argv[index + 1] : argument.slice(equalsIndex + 1);
    if (value === undefined || value === '') {
      return { kind: 'error', message: `Missing value for ${flag}` };
    }
    if (equalsIndex === -1) index += 1;

    if (flag === '--host') {
      options.host = value;
    } else if (flag === '--db') {
      options.db = value;
    } else {
      const port = Number(value);
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        return { kind: 'error', message: `--port must be an integer between 0 and 65535 (received: ${value})` };
      }
      options.port = port;
    }
  }

  if (options.host.trim() === '') return { kind: 'error', message: '--host must not be empty' };
  return { kind: 'options', options };
}

export function usageLine(): string {
  return `Usage: ${PROGRAM_NAME} [--host <address>] [--port <number>] [--db <path>] [--help] [--version]`;
}

export function helpText(): string {
  return `${PROGRAM_NAME} — read-only local usage dashboard for OpenCode

${usageLine()}

Options:
  --host <address>  Address to listen on. Default: ${DEFAULT_HOST} (loopback).
                    A private address, 0.0.0.0, or :: is used as given; no
                    extra flag, warning, or substitution is applied.
  --port <number>   Port to listen on. Default: ${DEFAULT_PORT}. 0 selects a
                    free port. A port already in use is reported as an error.
  --db <path>       OpenCode SQLite database to read. Resolution order:
                    --db, then $OPENCODE_DB, then $XDG_DATA_HOME/opencode/${DATABASE_FILE_NAME},
                    then ~/.local/share/opencode/${DATABASE_FILE_NAME}.
                    A relative --db path resolves against the working directory.
  --help            Print this help and exit.
  --version         Print the version and exit.

The database is always opened read-only. The dashboard never modifies OpenCode's
records, schema, or configuration, and it never installs dependencies at start.

Examples:
  npm run start -- --host 0.0.0.0
  npm run dev -- --host 0.0.0.0
  npm run start -- --db /path/to/backup.db
`;
}

function readVersion(): string {
  try {
    const raw = readFileSync(new URL('../../package.json', import.meta.url), 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function projectRoot(): string {
  return resolve(import.meta.dirname, '..', '..');
}

/** Format the listening address without substituting or rewriting the chosen host. */
export function formatAddress(host: string, port: number): string {
  const displayHost = host.includes(':') ? `[${host}]` : host;
  return `http://${displayHost}:${port}`;
}

interface ListenOutcome {
  port: number;
}

function listen(server: Server, host: string, port: number): Promise<ListenOutcome> {
  return new Promise((resolvePromise, rejectPromise) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      rejectPromise(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      const address = server.address();
      const boundPort = address !== null && typeof address === 'object' ? address.port : port;
      resolvePromise({ port: boundPort });
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({ host, port });
  });
}

export function describeListenError(error: Error, host: string, port: number): string {
  const code = (error as NodeJS.ErrnoException).code;
  const target = `${host}:${port}`;
  switch (code) {
    case 'EADDRINUSE':
      return `Cannot listen on ${target}: address already in use. Another process is using this port; choose a different port with --port.`;
    case 'EACCES':
      return `Cannot listen on ${target}: permission denied. Ports below 1024 usually require elevated privileges.`;
    case 'EADDRNOTAVAIL':
      return `Cannot listen on ${target}: address is not available on this machine. Choose a different --host.`;
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return `Cannot listen on ${target}: host could not be resolved.`;
    default:
      return `Cannot listen on ${target}: ${error.message}`;
  }
}

function registerShutdown(server: Server, closeDatabase: () => void, out: (message: string) => void): void {
  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    out(`Received ${signal}, shutting down.`);
    server.close(() => {
      closeDatabase();
      process.exit(0);
    });
    // Keep-alive sockets would otherwise delay close() indefinitely.
    server.closeIdleConnections();
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/** Run the CLI. Returns the intended process exit code. */
export async function run(argv: readonly string[]): Promise<number> {
  const parsed = parseCliArgs(argv);
  if (parsed.kind === 'error') {
    process.stderr.write(`${parsed.message}\n${usageLine()}\n`);
    return 2;
  }

  const { host, port, db, help, version } = parsed.options;
  if (help) {
    process.stdout.write(helpText());
    return 0;
  }
  if (version) {
    process.stdout.write(`${PROGRAM_NAME} ${readVersion()}\n`);
    return 0;
  }

  const resolved = resolveDatabasePath({ explicitDb: db });
  const database = createDatabaseAdapter({ path: resolved.path, pathSource: resolved.source });
  const server = createDashboardServer({ database, staticRoot: defaultStaticRoot(projectRoot()) });

  let outcome: ListenOutcome;
  try {
    outcome = await listen(server, host, port);
  } catch (error) {
    process.stderr.write(`${describeListenError(error as Error, host, port)}\n`);
    database.close();
    return 1;
  }

  const address = formatAddress(host, outcome.port);
  process.stdout.write(`${PROGRAM_NAME} listening on ${address}\n`);
  process.stdout.write(`Database: ${resolved.path} (${resolved.source}, read-only)\n`);
  process.stdout.write(`Health: ${address}/api/health\n`);

  registerShutdown(server, () => database.close(), (message) => process.stdout.write(`${message}\n`));
  return 0;
}

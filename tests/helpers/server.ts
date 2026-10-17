/**
 * Helpers for exercising the real server: an in-process HTTP listener and the
 * actual CLI entry point spawned as a child process.
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createConnection } from 'node:net';
import { resolve } from 'node:path';

import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ChildProcess } from 'node:child_process';

export const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..');
export const SERVER_ENTRY = resolve(PROJECT_ROOT, 'src', 'server', 'main.ts');

export interface RunningServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

/** Listen on an ephemeral loopback port and expose the base URL. */
export async function startHttpServer(server: Server): Promise<RunningServer> {
  server.listen({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    port: address.port,
    close: async () => {
      const closed = once(server, 'close');
      server.close();
      // Fetch keep-alive sockets would otherwise hold the server open.
      server.closeAllConnections();
      await closed;
    },
  };
}

export interface CliResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export interface RunCliOptions {
  env?: Record<string, string | undefined>;
  cwd?: string;
}

/** Run the CLI to completion (for `--help`, usage errors, listening failures). */
export async function runCli(args: readonly string[], options: RunCliOptions = {}): Promise<CliResult> {
  const child = spawn(process.execPath, [SERVER_ENTRY, ...args], {
    cwd: options.cwd ?? PROJECT_ROOT,
    env: { ...process.env, ...options.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  const [code, signal] = (await once(child, 'exit')) as [number | null, NodeJS.Signals | null];
  return { code, signal, stdout, stderr };
}

export interface RunningCli {
  child: ChildProcess;
  url: string;
  port: number;
  stdout: string;
  /** Send SIGTERM and wait for the process to exit. */
  stop(): Promise<CliResult>;
}

const LISTENING_PATTERN = /listening on (http:\/\/\S+)/;

/**
 * Start the real CLI on an ephemeral port and wait until it reports its
 * listening address. Wildcard hosts are reported as bound, not substituted, so
 * tests connect through 127.0.0.1 explicitly.
 */
export async function startCli(args: readonly string[], options: RunCliOptions = {}): Promise<RunningCli> {
  const child = spawn(process.execPath, [SERVER_ENTRY, ...args], {
    cwd: options.cwd ?? PROJECT_ROOT,
    env: { ...process.env, ...options.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  const address = await new Promise<string>((resolveAddress, rejectAddress) => {
    const timer = setTimeout(() => {
      rejectAddress(new Error(`Server did not report a listening address. stdout=${stdout} stderr=${stderr}`));
    }, 15_000);

    const onData = (chunk: string): void => {
      stdout += chunk;
      const match = LISTENING_PATTERN.exec(stdout);
      if (match?.[1] !== undefined) {
        clearTimeout(timer);
        resolveAddress(match[1]);
      }
    };

    child.stdout.on('data', onData);
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      rejectAddress(new Error(`Server exited with code ${String(code)}. stdout=${stdout} stderr=${stderr}`));
    });
  });

  const port = Number(new URL(address).port);

  return {
    child,
    url: address,
    port,
    get stdout() {
      return stdout;
    },
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        return { code: child.exitCode, signal: child.signalCode, stdout, stderr };
      }
      child.kill('SIGTERM');
      const [code, signal] = (await once(child, 'exit')) as [number | null, NodeJS.Signals | null];
      return { code, signal, stdout, stderr };
    },
  };
}

export async function fetchJson(
  url: string,
  init?: RequestInit,
): Promise<{ status: number; headers: Headers; body: unknown }> {
  const response = await fetch(url, init);
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: JSON.parse(text) as unknown };
}

export async function fetchText(
  url: string,
  init?: RequestInit,
): Promise<{ status: number; headers: Headers; text: string }> {
  const response = await fetch(url, init);
  return { status: response.status, headers: response.headers, text: await response.text() };
}

export interface RawResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/**
 * Send an HTTP/1.1 request through a raw socket.
 *
 * `fetch` normalizes dot segments before sending, which hides traversal-shaped
 * request targets; this helper sends the request line verbatim so the server's
 * own path handling is what gets exercised.
 */
export async function rawRequest(
  port: number,
  requestLine: string,
  options: { host?: string; accept?: string } = {},
): Promise<RawResponse> {
  const socket = createConnection({ host: '127.0.0.1', port });
  const chunks: Buffer[] = [];
  socket.on('data', (chunk: Buffer) => chunks.push(chunk));

  const finished = once(socket, 'close').then(() => Buffer.concat(chunks).toString('utf8'));
  socket.write(
    [
      requestLine,
      `Host: ${options.host ?? '127.0.0.1'}`,
      `Accept: ${options.accept ?? '*/*'}`,
      'Connection: close',
      '',
      '',
    ].join('\r\n'),
  );

  const raw = await finished;
  const separator = raw.indexOf('\r\n\r\n');
  const head = separator === -1 ? raw : raw.slice(0, separator);
  const body = separator === -1 ? '' : raw.slice(separator + 4);
  const [statusLine = '', ...headerLines] = head.split('\r\n');
  const status = Number(statusLine.split(' ')[1] ?? '0');

  const headers: Record<string, string> = {};
  for (const line of headerLines) {
    const colon = line.indexOf(':');
    if (colon > 0) headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
  }

  return { status, headers, body: headers['transfer-encoding'] === 'chunked' ? decodeChunked(body) : body };
}

function decodeChunked(body: string): string {
  let result = '';
  let rest = body;
  for (;;) {
    const newline = rest.indexOf('\r\n');
    if (newline === -1) break;
    const size = Number.parseInt(rest.slice(0, newline), 16);
    if (!Number.isFinite(size) || size <= 0) break;
    result += rest.slice(newline + 2, newline + 2 + size);
    rest = rest.slice(newline + 2 + size + 2);
  }
  return result;
}

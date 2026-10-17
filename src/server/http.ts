/**
 * Local HTTP interface: JSON API plus static serving of the built client.
 *
 * Plan references: §5. Deliberately small security model — no Host/Origin
 * allowlists, no IP restrictions, no CORS headers, no CSP subsystem, no
 * trust in forwarded headers. API responses are always `Cache-Control: no-store`
 * and unknown `/api/*` paths always return JSON, never the SPA document.
 */

import { createReadStream } from 'node:fs';
import { createServer } from 'node:http';

import type { IncomingMessage, Server, ServerResponse } from 'node:http';

import type { ApiErrorCode, ErrorEnvelope, HealthResponse } from '../shared/api.ts';
import type { DatabaseAdapter } from './database.ts';
import type { StaticResolution } from './static.ts';

import {
  MISSING_BUILD_INSTRUCTION,
  acceptsHtmlNavigation,
  contentTypeFor,
  resolveStaticRequest,
} from './static.ts';

export interface Logger {
  info(message: string): void;
  error(message: string): void;
}

export interface DashboardServerOptions {
  database: DatabaseAdapter;
  /** Absolute path of the built client (`dist/client`). */
  staticRoot: string;
  logger?: Logger;
}

const ERROR_STATUS: Record<ApiErrorCode, number> = {
  bad_request: 400,
  not_found: 404,
  method_not_allowed: 405,
  database_unavailable: 503,
  internal_error: 500,
};

export function errorEnvelope(code: ApiErrorCode, message: string): ErrorEnvelope {
  return { generatedAt: new Date().toISOString(), error: { code, message } };
}

export function errorStatus(code: ApiErrorCode): number {
  return ERROR_STATUS[code];
}

/**
 * True when the request target addresses the JSON API.
 *
 * Uses the un-normalized request target so `/api/../x` is still treated as an
 * API request (and answered with JSON) rather than being routed to the SPA.
 */
export function isApiTarget(requestTarget: string): boolean {
  let target = requestTarget;
  if (!target.startsWith('/')) {
    try {
      target = new URL(target, 'http://dashboard.invalid').pathname;
    } catch {
      return false;
    }
  }
  const queryIndex = target.indexOf('?');
  const path = queryIndex === -1 ? target : target.slice(0, queryIndex);
  return path === '/api' || path.startsWith('/api/');
}

function setApiHeaders(res: ServerResponse): void {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

function sendJson(res: ServerResponse, status: number, payload: unknown, method: string | undefined): void {
  const body = Buffer.from(`${JSON.stringify(payload)}\n`, 'utf8');
  setApiHeaders(res);
  res.setHeader('Content-Length', String(body.byteLength));
  res.statusCode = status;
  if (method === 'HEAD') {
    res.end();
    return;
  }
  res.end(body);
}

/**
 * Build the dashboard HTTP server.
 *
 * `/api/health` reports database state and supported-schema status. Every
 * statistics request in later phases reads through `database.withRead`, which
 * starts and finishes one short read transaction per request.
 */
export function createDashboardServer(options: DashboardServerOptions): Server {
  const logger: Logger = options.logger ?? console;

  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const requestTarget = req.url ?? '/';
    let pathname: string;
    try {
      pathname = new URL(requestTarget, 'http://dashboard.invalid').pathname;
    } catch {
      sendJson(res, 400, errorEnvelope('bad_request', 'Request target is not a valid URL path'), req.method);
      return;
    }

    // API-ness is decided from the raw request target, so a request that merely
    // starts as `/api/...` can never fall through to the SPA document.
    if (isApiTarget(requestTarget)) {
      handleApiRequest(req, res, pathname, options);
      return;
    }

    await handleStaticRequest(req, res, pathname, options);
  };

  return createServer((req, res) => {
    handleRequest(req, res).catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : 'unknown error';
      logger.error(`Request failed: ${detail}`);
      if (!res.headersSent) {
        sendJson(res, 500, errorEnvelope('internal_error', 'Unexpected server error'), req.method);
        return;
      }
      res.destroy();
    });
  });
}

function handleApiRequest(req: IncomingMessage, res: ServerResponse, pathname: string, options: DashboardServerOptions): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    sendJson(
      res,
      errorStatus('method_not_allowed'),
      errorEnvelope('method_not_allowed', `${req.method} is not supported for ${pathname}`),
      req.method,
    );
    return;
  }

  if (pathname === '/api/health') {
    sendHealth(res, options.database, req.method);
    return;
  }

  // Unknown API paths always return JSON, never the SPA document.
  sendJson(res, errorStatus('not_found'), errorEnvelope('not_found', `Unknown API path: ${pathname}`), req.method);
}

function sendHealth(res: ServerResponse, database: DatabaseAdapter, method: string | undefined): void {
  const { status, schema } = database.inspect();
  const generatedAt = new Date().toISOString();

  if (status.state === 'ready') {
    const payload: HealthResponse = { generatedAt, status: 'ok', database: status, schema };
    sendJson(res, 200, payload, method);
    return;
  }

  const payload: HealthResponse = {
    generatedAt,
    status: 'unavailable',
    error: { code: 'database_unavailable', message: status.message },
    database: status,
    schema,
  };
  sendJson(res, errorStatus('database_unavailable'), payload, method);
}

async function handleStaticRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  options: DashboardServerOptions,
): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    sendText(res, 405, `${req.method} is not supported for static assets\n`, req.method);
    return;
  }

  const resolution = await resolveStaticRequest(
    { pathname, acceptsHtml: acceptsHtmlNavigation(req.headers.accept) },
    options.staticRoot,
  );

  serveStaticResolution(req, res, resolution);
}

function serveStaticResolution(req: IncomingMessage, res: ServerResponse, resolution: StaticResolution): void {
  switch (resolution.kind) {
    case 'bad-request':
      sendText(res, 400, 'Bad request\n', req.method);
      return;
    case 'not-found':
      sendText(res, 404, 'Not found\n', req.method);
      return;
    case 'missing-build':
      // Health and API stay usable; only document requests need the build.
      sendText(res, 503, `${MISSING_BUILD_INSTRUCTION}\n`, req.method);
      return;
    case 'asset': {
      const cacheControl = resolution.immutable ? 'public, max-age=31536000, immutable' : 'no-cache';
      res.setHeader('Content-Type', contentTypeFor(resolution.filePath));
      res.setHeader('Cache-Control', cacheControl);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.statusCode = 200;
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      const stream = createReadStream(resolution.filePath);
      stream.on('error', () => res.destroy());
      res.on('close', () => stream.destroy());
      stream.pipe(res);
      return;
    }
  }
}

function sendText(res: ServerResponse, status: number, message: string, method: string | undefined): void {
  const body = Buffer.from(message, 'utf8');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Length', String(body.byteLength));
  res.statusCode = status;
  if (method === 'HEAD') {
    res.end();
    return;
  }
  res.end(body);
}

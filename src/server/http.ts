/**
 * Local HTTP interface: JSON API plus static serving of the built client.
 *
 * Plan references: §5. Deliberately small security model — no Host/Origin
 * allowlists, no IP restrictions, no CORS headers, no CSP subsystem, no
 * trust in forwarded headers. API responses are always `Cache-Control: no-store`
 * and unknown `/api/*` paths always return JSON, never the SPA document.
 *
 * Statistics requests follow §3's refresh contract: one fresh, short read
 * transaction per response with a single captured clock value, finished before
 * the JSON payload is written. A database that cannot be read is `503` with the
 * typed envelope, never a stale or all-zero success.
 */

import { createReadStream } from 'node:fs';
import { createServer } from 'node:http';

import type { IncomingMessage, Server, ServerResponse } from 'node:http';

import type { HealthResponse } from '../shared/api.ts';
import type { DatabaseAdapter } from './database.ts';
import type { StaticResolution } from './static.ts';
import type { StatsRoute } from './stats.ts';

import { DatabaseUnavailableError } from './database.ts';
import { errorEnvelope, errorStatus } from './errors.ts';
import { createQueryRunner } from './metrics.ts';
import { prepareStatsRequest } from './stats.ts';
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

export { errorEnvelope, errorStatus };

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
 * `/api/health` reports database state and supported-schema status; the
 * `/api/stats/*` and `/api/sessions*` endpoints return statistics. Every
 * statistics request reads through `database.withRead`, which starts and
 * finishes one short read transaction per response.
 */
export function createDashboardServer(options: DashboardServerOptions): Server {
  const logger: Logger = options.logger ?? console;

  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const requestTarget = req.url ?? '/';
    let url: URL;
    try {
      url = new URL(requestTarget, 'http://dashboard.invalid');
    } catch {
      sendJson(res, 400, errorEnvelope('bad_request', 'Request target is not a valid URL path'), req.method);
      return;
    }

    // API-ness is decided from the raw request target, so a request that merely
    // starts as `/api/...` can never fall through to the SPA document.
    if (isApiTarget(requestTarget)) {
      handleApiRequest(req, res, url, options, logger);
      return;
    }

    await handleStaticRequest(req, res, url.pathname, options);
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

interface ApiRouteMatch {
  route: StatsRoute;
  sessionId?: string;
}

/**
 * Route an API pathname. Returns null for anything the API does not serve, which
 * the caller answers as a JSON 404 (never the SPA document).
 */
function matchApiRoute(pathname: string): ApiRouteMatch | null {
  switch (pathname) {
    case '/api/stats/overview':
      return { route: 'stats/overview' };
    case '/api/stats/models':
      return { route: 'stats/models' };
    case '/api/stats/projects':
      return { route: 'stats/projects' };
    case '/api/stats/tools':
      return { route: 'stats/tools' };
    case '/api/stats/errors':
      return { route: 'stats/errors' };
    case '/api/sessions':
      return { route: 'sessions' };
    default:
      break;
  }

  const prefix = '/api/sessions/';
  if (!pathname.startsWith(prefix)) return null;
  const encodedId = pathname.slice(prefix.length);
  if (encodedId === '' || encodedId.includes('/')) return null;
  try {
    const sessionId = decodeURIComponent(encodedId);
    if (sessionId === '') return null;
    return { route: 'session', sessionId };
  } catch {
    return null;
  }
}

function handleApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  options: DashboardServerOptions,
  logger: Logger,
): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    sendJson(
      res,
      errorStatus('method_not_allowed'),
      errorEnvelope('method_not_allowed', `${req.method} is not supported for ${url.pathname}`),
      req.method,
    );
    return;
  }

  if (url.pathname === '/api/health') {
    sendHealth(res, options.database, req.method);
    return;
  }

  const match = matchApiRoute(url.pathname);
  if (match === null) {
    // Unknown API paths always return JSON, never the SPA document.
    sendJson(res, errorStatus('not_found'), errorEnvelope('not_found', `Unknown API path: ${url.pathname}`), req.method);
    return;
  }

  sendStatistics(req, res, match, url.searchParams, options, logger);
}

/** Validate, read inside one transaction, and write the response. */
function sendStatistics(
  req: IncomingMessage,
  res: ServerResponse,
  match: ApiRouteMatch,
  params: URLSearchParams,
  options: DashboardServerOptions,
  logger: Logger,
): void {
  // One clock value per response: it resolves the range, stamps `generatedAt`,
  // and appears in any error envelope produced from this request.
  const now = Date.now();
  const generatedAt = new Date(now).toISOString();

  const prepared = prepareStatsRequest(
    match.route,
    params,
    now,
    match.sessionId === undefined ? {} : { sessionId: match.sessionId },
  );
  if (!prepared.ok) {
    sendJson(res, errorStatus('bad_request'), errorEnvelope('bad_request', prepared.message, generatedAt), req.method);
    return;
  }

  let build: { status: number; payload: unknown };
  try {
    build = options.database.withRead((db) => prepared.build({ runner: createQueryRunner(db), now }));
  } catch (error) {
    if (error instanceof DatabaseUnavailableError) {
      sendJson(
        res,
        errorStatus('database_unavailable'),
        errorEnvelope('database_unavailable', error.status.message, generatedAt),
        req.method,
      );
      return;
    }
    const detail = error instanceof Error ? error.message : 'unknown error';
    logger.error(`Statistics request failed for ${match.route}: ${detail}`);
    sendJson(res, errorStatus('internal_error'), errorEnvelope('internal_error', 'Unexpected server error', generatedAt), req.method);
    return;
  }

  sendJson(res, build.status, build.payload, req.method);
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

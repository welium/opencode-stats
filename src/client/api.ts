/**
 * Browser request helper and typed endpoint wrappers.
 *
 * Plan references: §5 "Browser API requests use relative same-origin `/api/*`
 * URLs so they follow the address used to open the dashboard. Do not hardcode
 * localhost in the client" and §3's refresh contract ("Bypass browser HTTP
 * caches for API reads and prevent an older in-flight response from
 * overwriting refreshed results").
 *
 * Every read therefore uses a relative path, `cache: 'no-store'`, accepts JSON
 * only, and takes an `AbortSignal` so the caller can cancel a superseded
 * request. Failures are normalized into `ApiError` so pages can tell an
 * unavailable database apart from an ordinary request failure.
 */

import type {
  ErrorsResponse,
  ApiErrorCode,
  HealthResponse,
  ModelsResponse,
  OverviewResponse,
  ProjectsResponse,
  SessionDetailResponse,
  SessionsResponse,
  StatsRangeKey,
  ToolsResponse,
} from '../shared/api.ts';

/** A typed API failure: HTTP status plus the server's error code and message. */
export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;

  constructor(code: ApiErrorCode, status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

const ERROR_CODES: readonly ApiErrorCode[] = [
  'bad_request',
  'not_found',
  'method_not_allowed',
  'database_unavailable',
  'internal_error',
];

function readErrorEnvelope(payload: unknown): { code: ApiErrorCode; message: string } | null {
  if (payload === null || typeof payload !== 'object') return null;
  const error = (payload as { error?: unknown }).error;
  if (error === null || typeof error !== 'object') return null;
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (typeof code !== 'string' || !(ERROR_CODES as readonly string[]).includes(code)) return null;
  return { code: code as ApiErrorCode, message: typeof message === 'string' ? message : 'Request failed' };
}

async function readJson(response: Response, path: string): Promise<unknown> {
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    throw new ApiError('internal_error', response.status, `Unexpected response (${String(response.status)}) from ${path}`);
  }
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new ApiError('internal_error', response.status, `Malformed JSON response from ${path}`);
  }
}

async function getJson(path: string, signal?: AbortSignal): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: 'GET',
      headers: { accept: 'application/json' },
      cache: 'no-store',
      signal: signal ?? null,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError('internal_error', 0, error instanceof Error ? error.message : 'Request failed');
  }
  const payload = await readJson(response, path);
  if (response.ok) return payload;
  const envelope = readErrorEnvelope(payload);
  throw new ApiError(
    envelope?.code ?? 'internal_error',
    response.status,
    envelope?.message ?? `Request failed (${String(response.status)})`,
  );
}

/** Query-string inputs accepted by the statistics endpoints (all bound, §5). */
export interface StatsQuery {
  range: StatsRangeKey;
  projectId?: string | null | undefined;
  model?: string | null | undefined;
  search?: string | null | undefined;
  sort?: string | null | undefined;
  dir?: string | null | undefined;
  limit?: number | null | undefined;
  offset?: number | null | undefined;
}

/** Build a bounded query string, omitting unset and empty filters. */
export function buildQuery(params: StatsQuery): string {
  const search = new URLSearchParams();
  search.set('range', params.range);
  const scalars: ReadonlyArray<readonly [string, string | null | undefined]> = [
    ['projectId', params.projectId],
    ['model', params.model],
    ['search', params.search],
    ['sort', params.sort],
    ['dir', params.dir],
  ];
  for (const [key, value] of scalars) {
    if (value !== null && value !== undefined && value !== '') search.set(key, value);
  }
  if (params.limit !== null && params.limit !== undefined) search.set('limit', String(params.limit));
  if (params.offset !== null && params.offset !== undefined) search.set('offset', String(params.offset));
  return search.toString();
}

/**
 * `GET /api/health`. An unavailable database is a valid health answer (503 with
 * a typed envelope), so it is returned rather than thrown.
 */
export async function fetchHealth(signal?: AbortSignal): Promise<HealthResponse> {
  let response: Response;
  try {
    response = await fetch('/api/health', {
      method: 'GET',
      headers: { accept: 'application/json' },
      cache: 'no-store',
      signal: signal ?? null,
    });
  } catch (error) {
    throw new ApiError('internal_error', 0, error instanceof Error ? error.message : 'Request failed');
  }
  const payload = await readJson(response, '/api/health');
  const candidate = payload as Partial<HealthResponse> | null;
  if (candidate === null || (candidate.status !== 'ok' && candidate.status !== 'unavailable')) {
    const envelope = readErrorEnvelope(payload);
    throw new ApiError(envelope?.code ?? 'internal_error', response.status, envelope?.message ?? 'Health check failed');
  }
  return candidate as HealthResponse;
}

export async function fetchOverview(query: StatsQuery, signal?: AbortSignal): Promise<OverviewResponse> {
  return (await getJson(`/api/stats/overview?${buildQuery(query)}`, signal)) as OverviewResponse;
}

export async function fetchModels(query: StatsQuery, signal?: AbortSignal): Promise<ModelsResponse> {
  return (await getJson(`/api/stats/models?${buildQuery(query)}`, signal)) as ModelsResponse;
}

export async function fetchProjects(query: StatsQuery, signal?: AbortSignal): Promise<ProjectsResponse> {
  return (await getJson(`/api/stats/projects?${buildQuery(query)}`, signal)) as ProjectsResponse;
}

export async function fetchTools(query: StatsQuery, signal?: AbortSignal): Promise<ToolsResponse> {
  return (await getJson(`/api/stats/tools?${buildQuery(query)}`, signal)) as ToolsResponse;
}

export async function fetchErrors(query: StatsQuery, signal?: AbortSignal): Promise<ErrorsResponse> {
  return (await getJson(`/api/stats/errors?${buildQuery(query)}`, signal)) as ErrorsResponse;
}

export async function fetchSessions(query: StatsQuery, signal?: AbortSignal): Promise<SessionsResponse> {
  return (await getJson(`/api/sessions?${buildQuery(query)}`, signal)) as SessionsResponse;
}

export async function fetchSessionDetail(
  sessionId: string,
  query: StatsQuery,
  signal?: AbortSignal,
): Promise<SessionDetailResponse> {
  return (await getJson(`/api/sessions/${encodeURIComponent(sessionId)}?${buildQuery(query)}`, signal)) as SessionDetailResponse;
}

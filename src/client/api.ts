/**
 * Browser request helper.
 *
 * API reads use relative same-origin `/api/*` URLs so they follow the address
 * used to open the dashboard; browser HTTP caches are bypassed for freshness
 * (§3 refresh contract, §5 security model).
 */

import type { HealthResponse } from '../shared/api.ts';

async function requestJson(path: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(path, {
    method: 'GET',
    headers: { accept: 'application/json' },
    cache: 'no-store',
    signal: signal ?? null,
  });

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    throw new Error(`Unexpected response (${String(response.status)}) from ${path}`);
  }
  return (await response.json()) as unknown;
}

/**
 * `GET /api/health`. An unavailable database is a valid health answer (503 with
 * a typed envelope), so it is returned rather than thrown.
 */
export async function fetchHealth(signal?: AbortSignal): Promise<HealthResponse> {
  return (await requestJson('/api/health', signal)) as HealthResponse;
}

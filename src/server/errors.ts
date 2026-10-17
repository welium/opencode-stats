/**
 * Typed API error envelope (§5).
 *
 * Codes map to HTTP statuses: 400 invalid input, 404 unknown resource, 405
 * unsupported method, 503 unavailable database, 500 unexpected failure. Messages
 * are safe summaries; raw error text and stack traces never reach the client.
 */

import type { ApiErrorCode, ErrorEnvelope } from '../shared/api.ts';

const ERROR_STATUS: Record<ApiErrorCode, number> = {
  bad_request: 400,
  not_found: 404,
  method_not_allowed: 405,
  database_unavailable: 503,
  internal_error: 500,
};

export function errorStatus(code: ApiErrorCode): number {
  return ERROR_STATUS[code];
}

/**
 * Build an error payload. `generatedAt` may be the request's captured clock so
 * one response never mixes two timestamps.
 */
export function errorEnvelope(code: ApiErrorCode, message: string, generatedAt?: string): ErrorEnvelope {
  return { generatedAt: generatedAt ?? new Date().toISOString(), error: { code, message } };
}

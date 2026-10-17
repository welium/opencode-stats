/**
 * Response types shared by the dashboard server and the browser client.
 *
 * All payloads follow the envelope style of the implementation plan (§5):
 * a `generatedAt` capture timestamp, plus a consistent typed error envelope
 * whose `code` maps to the HTTP status used by the API.
 *
 * This module is types-only so it can be imported by Node's type-stripping
 * loader and by the browser bundle without emitting runtime code.
 */

/** HTTP status derivation for the error envelope. */
export type ApiErrorCode =
  | 'bad_request'
  | 'not_found'
  | 'method_not_allowed'
  | 'database_unavailable'
  | 'internal_error';

/** Which source produced the resolved database path. */
export type DatabasePathSource = 'flag' | 'env' | 'xdg-data-home' | 'home-local-share';

/**
 * Distinct database conditions. `missing` is never treated as an empty usage
 * history; `incompatible` is never treated as a successful all-zero result.
 */
export type DatabaseState =
  | 'ready'
  | 'missing'
  | 'unreadable'
  | 'incompatible'
  | 'corrupt'
  | 'busy'
  | 'error';

/** Safe, structured detail about the configured database. */
export interface DatabaseStatus {
  /** Absolute path that was resolved and inspected. */
  path: string;
  pathSource: DatabasePathSource;
  state: DatabaseState;
  /** Safe human message; never contains raw database content. */
  message: string;
  /** Optional low-level SQLite detail (error string only). */
  detail?: string;
}

/** Required-schema probe result. */
export interface SchemaStatus {
  /** True only when every required table and column is present. */
  supported: boolean;
  /** False when the database could not be opened, so nothing was probed. */
  checked: boolean;
  missingTables: string[];
  missingColumns: SchemaMissingColumns[];
}

export interface SchemaMissingColumns {
  table: string;
  columns: string[];
}

export interface ApiError {
  code: ApiErrorCode;
  message: string;
}

/** Error payload used for 400/404/405/503/500 responses. */
export interface ErrorEnvelope {
  generatedAt: string;
  error: ApiError;
}

/** `GET /api/health` — database state and supported-schema status. */
export interface HealthResponse {
  generatedAt: string;
  status: 'ok' | 'unavailable';
  database: DatabaseStatus;
  schema: SchemaStatus;
  /** Present only when `status` is `unavailable`. */
  error?: ApiError;
}

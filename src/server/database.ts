/**
 * Read-only access to OpenCode's local SQLite database.
 *
 * Plan references: §3 "Database path and access" and "Refresh contract", §4
 * "Storage adapter and metric rules", §7 Phase 1.
 *
 * Guarantees implemented here:
 *  - paths resolve from `--db`, then `OPENCODE_DB`, then XDG data home
 *  - the connection is opened `readOnly` with a bounded busy timeout, extension
 *    loading disabled, ATTACH disabled, and no immutable mode
 *  - missing, unreadable, incompatible, corrupt, and busy databases are
 *    reported as distinct states instead of a single failure
 *  - a failed open is retried on every request (never cached forever), and the
 *    file is reopened when it has been replaced
 *  - every read runs inside a fresh, short transaction that is finished before
 *    the caller does anything else, so newly committed WAL data becomes visible
 */

import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type {
  DatabasePathSource,
  DatabaseState,
  DatabaseStatus,
  SchemaMissingColumns,
  SchemaStatus,
} from '../shared/api.ts';

export const DATABASE_FILE_NAME = 'opencode.db';

/**
 * Bounded busy timeout. The live OpenCode database is actively written, so a
 * short wait avoids spurious failures while keeping every request bounded.
 */
export const DEFAULT_BUSY_TIMEOUT_MS = 2500;

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

export interface ResolveDatabasePathOptions {
  /** Value of `--db`, when provided. */
  explicitDb?: string | undefined;
  env?: Record<string, string | undefined>;
  cwd?: string;
  home?: string;
}

export interface ResolvedDatabasePath {
  path: string;
  source: DatabasePathSource;
}

/**
 * Resolution order: explicit `--db`, then nonempty `OPENCODE_DB`, then
 * `$XDG_DATA_HOME/opencode/opencode.db`, then `~/.local/share/opencode/opencode.db`.
 *
 * XDG semantics: an empty or relative `XDG_DATA_HOME` does not replace the
 * default. A relative explicit/managed path resolves against the working directory.
 */
export function resolveDatabasePath(options: ResolveDatabasePathOptions = {}): ResolvedDatabasePath {
  const cwd = options.cwd ?? process.cwd();
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;

  const explicit = options.explicitDb?.trim();
  if (explicit !== undefined && explicit !== '') {
    return { path: resolve(cwd, explicit), source: 'flag' };
  }

  const fromEnv = env.OPENCODE_DB?.trim();
  if (fromEnv !== undefined && fromEnv !== '') {
    return { path: resolve(cwd, fromEnv), source: 'env' };
  }

  const dataHome = env.XDG_DATA_HOME?.trim();
  if (dataHome !== undefined && dataHome !== '' && isAbsolute(dataHome)) {
    return { path: join(dataHome, 'opencode', DATABASE_FILE_NAME), source: 'xdg-data-home' };
  }

  return { path: join(home, '.local', 'share', 'opencode', DATABASE_FILE_NAME), source: 'home-local-share' };
}

// ---------------------------------------------------------------------------
// Required schema
// ---------------------------------------------------------------------------

interface RequiredTable {
  table: string;
  columns: readonly string[];
}

/**
 * Columns the dashboard reads, as verified in §4 "Verified shapes". `kv` is
 * deliberately absent: the local pricing catalog is optional and only affects
 * offline estimates, so a database without it is still supported.
 */
export const REQUIRED_SCHEMA: readonly RequiredTable[] = [
  {
    table: 'session_v2',
    columns: [
      'id',
      'project_id',
      'parent_id',
      'fork_session_id',
      'directory',
      'title',
      'model',
      'cost',
      'tokens_input',
      'tokens_output',
      'tokens_reasoning',
      'tokens_cache_read',
      'tokens_cache_write',
      'time_created',
      'time_updated',
    ],
  },
  { table: 'session_message', columns: ['id', 'session_id', 'type', 'seq', 'time_created', 'time_updated', 'data'] },
  { table: 'project', columns: ['id', 'worktree', 'name'] },
];

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function uncheckedSchema(): SchemaStatus {
  return { supported: false, checked: false, missingTables: [], missingColumns: [] };
}

/**
 * Probe the required tables and columns. Table names come from the frozen
 * constant above, never from user input or request data.
 */
export function probeSchema(db: DatabaseSync): SchemaStatus {
  const existing = new Set<string>();
  for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()) {
    if (typeof row.name === 'string') existing.add(row.name);
  }

  const missingTables: string[] = [];
  const missingColumns: SchemaMissingColumns[] = [];

  for (const required of REQUIRED_SCHEMA) {
    if (!IDENTIFIER.test(required.table)) {
      throw new Error(`Invalid required table name: ${required.table}`);
    }
    if (!existing.has(required.table)) {
      missingTables.push(required.table);
      continue;
    }

    const present = new Set<string>();
    for (const row of db.prepare('SELECT name FROM pragma_table_info(?)').all(required.table)) {
      if (typeof row.name === 'string') present.add(row.name);
    }
    const missing = required.columns.filter((column) => !present.has(column));
    if (missing.length > 0) missingColumns.push({ table: required.table, columns: missing });

    // Touch real data pages so corruption outside sqlite_master is surfaced.
    db.prepare(`SELECT 1 FROM "${required.table}" LIMIT 1`).all();
  }

  return {
    supported: missingTables.length === 0 && missingColumns.length === 0,
    checked: true,
    missingTables,
    missingColumns,
  };
}

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

type FileState =
  | { kind: 'file'; identity: string }
  | { kind: 'missing' }
  | { kind: 'unreadable'; detail: string }
  | { kind: 'not-a-file'; detail: string }
  | { kind: 'unknown'; detail: string };

function statDatabaseFile(path: string): FileState {
  try {
    const stats = statSync(path);
    if (stats.isDirectory()) return { kind: 'not-a-file', detail: 'resolved path is a directory' };
    if (!stats.isFile()) return { kind: 'not-a-file', detail: 'resolved path is not a regular file' };
    // Inode identity detects a replaced database file; a live database keeps the
    // same inode while its contents change.
    return { kind: 'file', identity: `${stats.dev}:${stats.ino}` };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { kind: 'missing' };
    if (code === 'EACCES' || code === 'EPERM') {
      return { kind: 'unreadable', detail: `cannot inspect database file (${code})` };
    }
    return { kind: 'unknown', detail: `cannot inspect database file (${code ?? 'unknown error'})` };
  }
}

function sqliteErrorDetail(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object') return undefined;
  const candidate = error as { errcode?: unknown; errstr?: unknown; message?: unknown };
  if (typeof candidate.errstr === 'string' && candidate.errstr !== '') return candidate.errstr;
  if (typeof candidate.message === 'string' && candidate.message !== '') return candidate.message;
  return undefined;
}

/** Extended SQLite result codes that map to a database state. */
export const SQLITE_BUSY = 5;
export const SQLITE_LOCKED = 6;
export const SQLITE_CORRUPT = 11;
export const SQLITE_CANTOPEN = 14;
export const SQLITE_NOTADB = 26;

function classifyFailure(error: unknown, file: FileState): DatabaseState {
  const errcode = (error as { errcode?: unknown } | null)?.errcode;
  if (typeof errcode === 'number') {
    switch (errcode) {
      case SQLITE_BUSY:
      case SQLITE_LOCKED:
        return 'busy';
      case SQLITE_CORRUPT:
      case SQLITE_NOTADB:
        return 'corrupt';
      case SQLITE_CANTOPEN:
        // SQLITE_CANTOPEN covers both "file does not exist" and "file exists
        // but is not readable"; the filesystem state tells them apart.
        return file.kind === 'missing' ? 'missing' : 'unreadable';
      default:
        break;
    }
  }
  if (file.kind === 'missing') return 'missing';
  if (file.kind === 'unreadable') return 'unreadable';
  if (file.kind === 'not-a-file') return 'error';
  return 'error';
}

const STATE_MESSAGES: Record<DatabaseState, string> = {
  ready: 'OpenCode database is available (read-only)',
  missing: 'OpenCode database was not found at the configured path',
  unreadable: 'OpenCode database exists but cannot be read by this process',
  incompatible: 'OpenCode database schema is not supported by this dashboard',
  corrupt: 'OpenCode database is not a valid or readable SQLite database',
  busy: 'OpenCode database is locked by another process',
  error: 'OpenCode database could not be opened',
};

/** Thrown by `withRead` when the database is not currently readable. */
export class DatabaseUnavailableError extends Error {
  readonly status: DatabaseStatus;

  constructor(status: DatabaseStatus) {
    super(status.message);
    this.name = 'DatabaseUnavailableError';
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export interface DatabaseAdapterOptions {
  /** Absolute path resolved by `resolveDatabasePath`. */
  path: string;
  pathSource: DatabasePathSource;
  /** Overridable only to keep tests fast; production uses the bounded default. */
  busyTimeoutMs?: number;
}

export interface DatabaseInspection {
  status: DatabaseStatus;
  schema: SchemaStatus;
}

export interface DatabaseAdapter {
  readonly path: string;
  readonly pathSource: DatabasePathSource;
  /** Current state, attempting (or retrying) an open when needed. */
  inspect(): DatabaseInspection;
  /**
   * Run `run` inside one short read transaction on a read-only connection.
   * The transaction is committed before returning; `run` must be synchronous so
   * the snapshot is not held while the response is being written.
   */
  withRead<T>(run: (db: DatabaseSync) => T): T;
  close(): void;
}

function describeStatus(path: string, pathSource: DatabasePathSource, state: DatabaseState, detail?: string): DatabaseStatus {
  const status: DatabaseStatus = { path, pathSource, state, message: STATE_MESSAGES[state] };
  if (detail !== undefined && detail !== '') status.detail = detail;
  return status;
}

function describeSchemaProblem(schema: SchemaStatus): string {
  const parts: string[] = [];
  if (schema.missingTables.length > 0) parts.push(`missing tables: ${schema.missingTables.join(', ')}`);
  if (schema.missingColumns.length > 0) {
    parts.push(
      `missing columns: ${schema.missingColumns.map((entry) => `${entry.table}(${entry.columns.join(', ')})`).join('; ')}`,
    );
  }
  return parts.join('; ') || 'required tables or columns are not present';
}

export function createDatabaseAdapter(options: DatabaseAdapterOptions): DatabaseAdapter {
  const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
  const openOptions = {
    readOnly: true,
    allowExtension: false,
    timeout: busyTimeoutMs,
    limits: { attach: 0 },
  } as const;

  let handle: DatabaseSync | null = null;
  let handleIdentity: string | null = null;
  let handleSchema: SchemaStatus | null = null;

  function closeHandle(): void {
    if (handle !== null) {
      try {
        handle.close();
      } catch {
        // A failed close must not mask the state we are about to report.
      }
    }
    handle = null;
    handleIdentity = null;
    handleSchema = null;
  }

  type OpenResult =
    | { ok: true; db: DatabaseSync; schema: SchemaStatus }
    | { ok: false; status: DatabaseStatus; schema: SchemaStatus };

  /**
   * Attempt to obtain a healthy, schema-compatible read-only connection.
   * Failures are reported but never cached: the next call retries.
   */
  function tryOpen(): OpenResult {
    const file = statDatabaseFile(options.path);
    if (file.kind !== 'file') {
      closeHandle();
      const state: DatabaseState =
        file.kind === 'missing' ? 'missing' : file.kind === 'unreadable' ? 'unreadable' : 'error';
      const detail = 'detail' in file ? file.detail : undefined;
      return { ok: false, status: describeStatus(options.path, options.pathSource, state, detail), schema: uncheckedSchema() };
    }

    if (handle !== null && handleIdentity === file.identity) {
      return { ok: true, db: handle, schema: handleSchema ?? uncheckedSchema() };
    }

    // The file is new, replaced, or previously failed: drop any stale handle.
    closeHandle();

    let candidate: DatabaseSync | null = null;
    try {
      candidate = new DatabaseSync(options.path, openOptions);
      const schema = probeSchema(candidate);
      if (!schema.supported) {
        candidate.close();
        candidate = null;
        return {
          ok: false,
          status: describeStatus(options.path, options.pathSource, 'incompatible', describeSchemaProblem(schema)),
          schema,
        };
      }
      handle = candidate;
      handleIdentity = file.identity;
      handleSchema = schema;
      return { ok: true, db: candidate, schema };
    } catch (error) {
      if (candidate !== null) {
        try {
          candidate.close();
        } catch {
          // Ignore: the open already failed.
        }
      }
      const state = classifyFailure(error, file);
      return {
        ok: false,
        status: describeStatus(options.path, options.pathSource, state, sqliteErrorDetail(error)),
        schema: uncheckedSchema(),
      };
    }
  }

  return {
    path: options.path,
    pathSource: options.pathSource,

    inspect(): DatabaseInspection {
      const result = tryOpen();
      if (result.ok) {
        return { status: describeStatus(options.path, options.pathSource, 'ready'), schema: result.schema };
      }
      return { status: result.status, schema: result.schema };
    },

    withRead<T>(run: (db: DatabaseSync) => T): T {
      const result = tryOpen();
      if (!result.ok) throw new DatabaseUnavailableError(result.status);
      const db = result.db;
      db.exec('BEGIN');
      try {
        const value = run(db);
        db.exec('COMMIT');
        return value;
      } catch (error) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // The transaction may already have been rolled back by SQLite.
        }
        throw error;
      }
    },

    close(): void {
      closeHandle();
    },
  };
}

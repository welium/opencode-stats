/**
 * Synthetic SQLite fixtures for the Phase 1 gate.
 *
 * Every fixture is created under the OS temporary directory (`TMPDIR`) and is
 * never the user's live OpenCode database. The schema DDL below is written
 * independently of the server's required-schema constants on purpose: if the
 * adapter starts demanding a column these fixtures do not create, the tests fail
 * instead of silently agreeing with the implementation.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// ---------------------------------------------------------------------------
// Temporary directories
// ---------------------------------------------------------------------------

export function createTempDir(prefix = 'opencode-dashboard-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function removeTempDir(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA_SQL = [
  `CREATE TABLE project (
     id TEXT PRIMARY KEY,
     worktree TEXT,
     vcs TEXT,
     name TEXT,
     time_created INTEGER,
     time_updated INTEGER
   )`,
  `CREATE TABLE session_v2 (
     id TEXT PRIMARY KEY,
     project_id TEXT,
     workspace_id TEXT,
     parent_id TEXT,
     fork_session_id TEXT,
     slug TEXT,
     directory TEXT,
     title TEXT,
     model TEXT,
     cost REAL,
     tokens_input INTEGER,
     tokens_output INTEGER,
     tokens_reasoning INTEGER,
     tokens_cache_read INTEGER,
     tokens_cache_write INTEGER,
     time_created INTEGER,
     time_updated INTEGER
   )`,
  `CREATE TABLE session_message (
     id TEXT PRIMARY KEY,
     session_id TEXT,
     type TEXT,
     seq INTEGER,
     time_created INTEGER,
     time_updated INTEGER,
     data TEXT
   )`,
  `CREATE TABLE kv (
     key TEXT PRIMARY KEY,
     value TEXT,
     time_created INTEGER,
     time_updated INTEGER
   )`,
];

export function applySchema(db: DatabaseSync): void {
  for (const statement of SCHEMA_SQL) db.exec(statement);
}

/**
 * Indexes the live OpenCode v2.0.32 database provides over the tables the
 * dashboard reads (verified read-only on 2026-10-17). Correctness fixtures stay
 * index-free on purpose; performance fixtures add these so `EXPLAIN QUERY PLAN`
 * output matches production instead of an unrealistically bare schema.
 */
export const OPENCODE_READ_INDEXES: readonly string[] = [
  'CREATE INDEX session_message_time_created_idx ON session_message (time_created)',
  'CREATE INDEX session_message_session_time_created_id_idx ON session_message (session_id, time_created, id)',
  'CREATE INDEX session_v2_project_idx ON session_v2 (project_id)',
  'CREATE INDEX session_v2_parent_idx ON session_v2 (parent_id)',
];

export function applyReadIndexes(db: DatabaseSync): void {
  for (const statement of OPENCODE_READ_INDEXES) db.exec(statement);
}

export interface FixtureSession {
  id: string;
  projectId?: string | null;
  parentId?: string | null;
  /** Non-null marks the session as a fork of another session. */
  forkSessionId?: string | null;
  title?: string | null;
  model?: string | null;
  directory?: string;
  timeCreated?: number;
  timeUpdated?: number;
  cost?: number | null;
  tokens?: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number };
}

export interface FixtureMessage {
  id: string;
  sessionId: string;
  /** Any message type the dashboard must classify; defaults are not injected. */
  type: 'user' | 'assistant' | 'compaction' | 'synthetic' | 'system' | 'idle' | 'model-switched' | string;
  seq: number;
  timeCreated?: number;
  timeUpdated?: number;
  /** Object payloads are serialized; a raw string or null is stored verbatim. */
  data?: string | null | Record<string, unknown>;
}

export function insertSession(db: DatabaseSync, session: FixtureSession): void {
  const tokens = session.tokens ?? { input: 100, output: 20, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
  db.prepare(
    `INSERT INTO session_v2 (id, project_id, parent_id, fork_session_id, directory, title, model, cost,
       tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write,
       time_created, time_updated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    session.id,
    session.projectId ?? null,
    session.parentId ?? null,
    session.forkSessionId ?? null,
    session.directory ?? '/tmp/project',
    session.title === undefined ? `Session ${session.id}` : session.title,
    session.model ?? null,
    session.cost === undefined ? 0.5 : session.cost,
    tokens.input,
    tokens.output,
    tokens.reasoning,
    tokens.cacheRead,
    tokens.cacheWrite,
    session.timeCreated ?? 1_700_000_000_000,
    session.timeUpdated ?? 1_700_000_100_000,
  );
}

export function insertMessage(db: DatabaseSync, message: FixtureMessage): void {
  const data =
    message.data === undefined
      ? JSON.stringify({ role: message.type })
      : typeof message.data === 'string' || message.data === null
        ? message.data
        : JSON.stringify(message.data);
  db.prepare(
    `INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    message.id,
    message.sessionId,
    message.type,
    message.seq,
    message.timeCreated ?? 1_700_000_000_000,
    message.timeUpdated ?? message.timeCreated ?? 1_700_000_100_000,
    data,
  );
}

export function insertProject(db: DatabaseSync, id: string, name: string | null = `Project ${id}`, worktree?: string): void {
  db.prepare('INSERT INTO project (id, worktree, name) VALUES (?, ?, ?)').run(id, worktree ?? `/tmp/${id}`, name);
}

// ---------------------------------------------------------------------------
// Assistant message payloads
// ---------------------------------------------------------------------------

export interface FixtureToolItem {
  name?: string | null;
  /** `state.status`; absent means finished-but-unreported. */
  status?: string | null;
  /** Top-level tool time — the authoritative timestamps the dashboard reads. */
  time?: { created?: number | null; ran?: number | null; completed?: number | null };
  /** Deliberately divergent `state.time`, used to prove it is ignored. */
  stateTime?: { created?: number; ran?: number; completed?: number };
  type?: string;
  input?: Record<string, unknown>;
}

/** A `content[]` tool item shaped like the verified payload (§4). */
export function toolItem(options: FixtureToolItem = {}): Record<string, unknown> {
  const state: Record<string, unknown> = { status: options.status ?? 'completed', input: options.input ?? {} };
  if (options.stateTime !== undefined) state.time = options.stateTime;
  return {
    type: options.type ?? 'tool',
    name: options.name ?? 'tool',
    state,
    time: {
      created: options.time?.created ?? null,
      ran: options.time?.ran ?? null,
      completed: options.time?.completed ?? null,
    },
  };
}

export interface FixtureAssistantPayload {
  time?: { created: number; streamed?: number; completed?: number };
  agent?: string | null;
  model?: { id?: string | null; providerID?: string | null; variant?: string | null } | null;
  content?: unknown[];
  cost?: number | null;
  tokens?: { input: number; output: number; reasoning: number; cache?: { read: number; write: number } } | null;
  error?: { type: string; message?: string } | null;
}

/**
 * Build an assistant payload. `cost` and `tokens` are omitted when set to
 * `null`, which is how an unfinished or errored step looks on disk; explicit
 * zeros stay present so tests can tell a measured zero from missing data.
 */
export function assistantPayload(options: FixtureAssistantPayload = {}): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    time: options.time ?? { created: 1_700_000_000_000, streamed: 1_700_000_000_100, completed: 1_700_000_000_200 },
    agent: options.agent === undefined ? 'build' : options.agent,
    model: options.model === undefined ? { id: 'model-a', providerID: 'provider-a', variant: 'high' } : options.model,
    content: options.content ?? [],
  };
  if (options.cost !== null && options.cost !== undefined) payload.cost = options.cost;
  if (options.tokens !== null && options.tokens !== undefined) {
    payload.tokens = {
      input: options.tokens.input,
      output: options.tokens.output,
      reasoning: options.tokens.reasoning,
      cache: { read: options.tokens.cache?.read ?? 0, write: options.tokens.cache?.write ?? 0 },
    };
  }
  if (options.error !== null && options.error !== undefined) payload.error = options.error;
  return payload;
}

/** A user payload; only `time.created` matters to the metrics. */
export function userPayload(timeCreated: number): Record<string, unknown> {
  return { time: { created: timeCreated }, text: 'ignored by metrics' };
}

/** A compaction payload, which assistant-only totals must not include (§4). */
export function compactionPayload(options: {
  time: number;
  cost?: number;
  tokens?: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number };
}): Record<string, unknown> {
  return {
    time: { created: options.time },
    status: 'completed',
    reason: 'auto',
    cost: options.cost ?? 99,
    tokens: options.tokens ?? { input: 9999, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };
}

function openWritable(path: string, journalMode: 'wal' | 'delete'): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode = ${journalMode}`);
  return db;
}

/** Open a schema-initialized writable fixture database (tests only). */
export function openFixtureDatabase(path: string, journalMode: 'wal' | 'delete' = 'delete'): DatabaseSync {
  const db = openWritable(path, journalMode);
  applySchema(db);
  return db;
}

// ---------------------------------------------------------------------------
// Database fixtures
// ---------------------------------------------------------------------------

export interface CompatibleDatabaseOptions {
  journalMode?: 'wal' | 'delete';
  /** Sessions to seed. Defaults to one project, one root session, one message. */
  seed?: boolean;
}

/** A compatible database: every required table and column is present. */
export function createCompatibleDatabase(path: string, options: CompatibleDatabaseOptions = {}): void {
  const db = openWritable(path, options.journalMode ?? 'delete');
  applySchema(db);
  if (options.seed !== false) {
    insertProject(db, 'proj-1');
    insertSession(db, { id: 'ses-root', projectId: 'proj-1', model: 'provider/model-a' });
    insertMessage(db, { id: 'msg-1', sessionId: 'ses-root', type: 'user', seq: 0 });
  }
  db.close();
}

/** A compatible but empty database: supported schema, zero usage history. */
export function createEmptyCompatibleDatabase(path: string, journalMode: 'wal' | 'delete' = 'delete'): void {
  createCompatibleDatabase(path, { journalMode, seed: false });
}

/** Tables exist but a required column is missing. */
export function createDatabaseWithMissingColumns(path: string, journalMode: 'wal' | 'delete' = 'delete'): void {
  const db = openWritable(path, journalMode);
  db.exec('CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT, name TEXT)');
  db.exec(
    `CREATE TABLE session_v2 (
       id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, directory TEXT, title TEXT, model TEXT,
       cost REAL, tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER,
       time_created INTEGER, time_updated INTEGER
     )`,
  );
  // session_message lacks `data`.
  db.exec(
    `CREATE TABLE session_message (
       id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER
     )`,
  );
  db.close();
}

/** Completely different tables: an unrelated SQLite database. */
export function createUnrelatedDatabase(path: string, journalMode: 'wal' | 'delete' = 'delete'): void {
  const db = openWritable(path, journalMode);
  db.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)');
  db.prepare('INSERT INTO notes (body) VALUES (?)').run('unrelated');
  db.close();
}

/** A file that is not a SQLite database at all. */
export function createCorruptDatabase(path: string): void {
  writeFileSync(path, Buffer.from('this is not a sqlite database file, written for a corruption test '.repeat(20)));
}

/** A valid database header with truncated pages, so reads fail inside the file. */
export function createTruncatedDatabase(path: string): void {
  const db = openWritable(path, 'delete');
  applySchema(db);
  insertProject(db, 'proj-1');
  insertSession(db, { id: 'ses-1', projectId: 'proj-1' });
  const insert = db.prepare(
    `INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (let index = 0; index < 400; index += 1) {
    insert.run(`msg-${String(index)}`, 'ses-1', 'assistant', index, 1_700_000_000_000, 1_700_000_000_000, 'x'.repeat(200));
  }
  db.close();
  // Page 1 (header and schema) survives; the table pages do not.
  truncateSync(path, 4096 * 2 + 100);
}

// ---------------------------------------------------------------------------
// File inspection helpers
// ---------------------------------------------------------------------------

export interface FileFingerprint {
  sha256: string;
  size: number;
  mtimeMs: number;
}

export function fingerprintFile(path: string): FileFingerprint {
  const stats = statSync(path);
  return {
    sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
    size: stats.size,
    mtimeMs: stats.mtimeMs,
  };
}

/** Schema text of every table/view/trigger, used to prove nothing was altered. */
export function schemaFingerprint(path: string): string {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = db.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY type, name').all();
    return JSON.stringify(rows);
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Static build fixtures
// ---------------------------------------------------------------------------

export interface StaticRootFixture {
  /** Directory that plays the role of `dist/client`. */
  root: string;
  /** File outside the static root, used to prove symlink escapes are rejected. */
  outsideFile: string;
}

/**
 * Build a minimal static root shaped like Vite output, plus an outside file and
 * symlinks: one escaping the root, one staying inside it.
 */
export function createStaticRootFixture(baseDir: string, options: { withIndex?: boolean } = {}): StaticRootFixture {
  const root = join(baseDir, 'dist', 'client');
  const outsideDir = join(baseDir, 'outside');
  mkdirSync(join(root, 'assets'), { recursive: true });
  mkdirSync(outsideDir, { recursive: true });

  const outsideFile = join(outsideDir, 'secret.txt');
  writeFileSync(outsideFile, 'outside-the-static-root\n');
  writeFileSync(join(root, 'assets', 'app-abc123.js'), 'console.log("built asset");\n');
  writeFileSync(join(root, 'robots.txt'), 'User-agent: *\n');
  if (options.withIndex !== false) {
    writeFileSync(join(root, 'index.html'), '<!doctype html><html><body><div id="root"></div></body></html>\n');
  }
  symlinkSync(outsideFile, join(root, 'escape.txt'));
  symlinkSync(join(root, 'assets', 'app-abc123.js'), join(root, 'assets', 'alias.js'));

  return { root, outsideFile };
}

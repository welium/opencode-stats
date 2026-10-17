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

export interface FixtureSession {
  id: string;
  projectId?: string | null;
  parentId?: string | null;
  title?: string;
  model?: string | null;
  timeCreated?: number;
  timeUpdated?: number;
}

export interface FixtureMessage {
  id: string;
  sessionId: string;
  type: 'user' | 'assistant';
  seq: number;
  timeCreated?: number;
  timeUpdated?: number;
  data?: string;
}

export function insertSession(db: DatabaseSync, session: FixtureSession): void {
  db.prepare(
    `INSERT INTO session_v2 (id, project_id, parent_id, fork_session_id, directory, title, model, cost,
       tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write,
       time_created, time_updated)
     VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    session.id,
    session.projectId ?? null,
    session.parentId ?? null,
    '/tmp/project',
    session.title ?? `Session ${session.id}`,
    session.model ?? null,
    0.5,
    100,
    20,
    0,
    0,
    0,
    session.timeCreated ?? 1_700_000_000_000,
    session.timeUpdated ?? 1_700_000_100_000,
  );
}

export function insertMessage(db: DatabaseSync, message: FixtureMessage): void {
  db.prepare(
    `INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    message.id,
    message.sessionId,
    message.type,
    message.seq,
    message.timeCreated ?? 1_700_000_000_000,
    message.timeUpdated ?? 1_700_000_100_000,
    message.data ?? JSON.stringify({ role: message.type }),
  );
}

export function insertProject(db: DatabaseSync, id: string, name: string | null = `Project ${id}`): void {
  db.prepare('INSERT INTO project (id, worktree, name) VALUES (?, ?, ?)').run(id, `/tmp/${id}`, name);
}

function openWritable(path: string, journalMode: 'wal' | 'delete'): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode = ${journalMode}`);
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

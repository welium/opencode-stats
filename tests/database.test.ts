/**
 * Phase 1 gate: read-only adapter behaviour.
 *
 * Covers distinct database states, write rejection through the read-only
 * connection, byte/schema stability of the source database, WAL visibility,
 * refresh/retry after a failed open, and recovery after file replacement.
 */

import assert from 'node:assert/strict';
import { chmodSync, existsSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import {
  DEFAULT_BUSY_TIMEOUT_MS,
  DatabaseUnavailableError,
  createDatabaseAdapter,
  resolveDatabasePath,
} from '../src/server/database.ts';

import {
  applySchema,
  createCompatibleDatabase,
  createCorruptDatabase,
  createDatabaseWithMissingColumns,
  createEmptyCompatibleDatabase,
  createTempDir,
  createTruncatedDatabase,
  createUnrelatedDatabase,
  fingerprintFile,
  insertMessage,
  insertProject,
  insertSession,
  removeTempDir,
  schemaFingerprint,
} from './helpers/fixtures.ts';

import type { DatabaseAdapter } from '../src/server/database.ts';

const PATH_SOURCE = 'flag' as const;

function adapterFor(path: string, busyTimeoutMs?: number): DatabaseAdapter {
  return createDatabaseAdapter(
    busyTimeoutMs === undefined ? { path, pathSource: PATH_SOURCE } : { path, pathSource: PATH_SOURCE, busyTimeoutMs },
  );
}

function countSessions(adapter: DatabaseAdapter): number {
  return adapter.withRead((db) => countRows(db));
}

function countRows(db: DatabaseSync): number {
  const row = db.prepare('SELECT count(*) AS total FROM session_v2').get();
  return Number(row?.total ?? -1);
}

describe('resolveDatabasePath', () => {
  const home = '/home/example';
  const env = { XDG_DATA_HOME: '/data/xdg' };

  it('prefers an explicit --db and resolves relative paths against the working directory', () => {
    assert.deepEqual(resolveDatabasePath({ explicitDb: 'nested/opencode.db', cwd: '/work', home, env }), {
      path: '/work/nested/opencode.db',
      source: 'flag',
    });
    assert.deepEqual(resolveDatabasePath({ explicitDb: '/abs/other.db', cwd: '/work', home, env }), {
      path: '/abs/other.db',
      source: 'flag',
    });
  });

  it('uses a nonempty OPENCODE_DB when no --db is given', () => {
    assert.deepEqual(
      resolveDatabasePath({ cwd: '/work', home, env: { ...env, OPENCODE_DB: '/srv/opencode.db' } }),
      { path: '/srv/opencode.db', source: 'env' },
    );
    assert.deepEqual(
      resolveDatabasePath({ cwd: '/work', home, env: { OPENCODE_DB: 'rel.db', XDG_DATA_HOME: '/data/xdg' } }),
      { path: '/work/rel.db', source: 'env' },
    );
  });

  it('ignores an empty or blank OPENCODE_DB', () => {
    assert.equal(
      resolveDatabasePath({ cwd: '/work', home, env: { OPENCODE_DB: '', XDG_DATA_HOME: '/data/xdg' } }).source,
      'xdg-data-home',
    );
    assert.equal(
      resolveDatabasePath({ cwd: '/work', home, env: { OPENCODE_DB: '   ', XDG_DATA_HOME: '/data/xdg' } }).source,
      'xdg-data-home',
    );
  });

  it('uses an absolute XDG_DATA_HOME', () => {
    assert.deepEqual(resolveDatabasePath({ cwd: '/work', home, env }), {
      path: '/data/xdg/opencode/opencode.db',
      source: 'xdg-data-home',
    });
  });

  it('falls back to ~/.local/share when XDG_DATA_HOME is empty or relative', () => {
    assert.deepEqual(resolveDatabasePath({ cwd: '/work', home, env: { XDG_DATA_HOME: '' } }), {
      path: join(home, '.local', 'share', 'opencode', 'opencode.db'),
      source: 'home-local-share',
    });
    assert.deepEqual(resolveDatabasePath({ cwd: '/work', home, env: { XDG_DATA_HOME: 'relative/data' } }), {
      path: join(home, '.local', 'share', 'opencode', 'opencode.db'),
      source: 'home-local-share',
    });
    assert.deepEqual(resolveDatabasePath({ cwd: '/work', home, env: {} }), {
      path: join(home, '.local', 'share', 'opencode', 'opencode.db'),
      source: 'home-local-share',
    });
  });
});

describe('database states', () => {
  it('reports a missing database without creating the file', () => {
    const dir = createTempDir();
    try {
      const path = join(dir, 'absent.db');
      const adapter = adapterFor(path);
      const first = adapter.inspect();
      assert.equal(first.status.state, 'missing');
      assert.equal(first.schema.checked, false);
      assert.equal(first.schema.supported, false);
      assert.match(first.status.message, /not found/i);
      // A missing database is not an empty history, and must not be created.
      assert.equal(existsSync(path), false);
      // Failures are retried, not cached: the same answer is reached again.
      assert.equal(adapter.inspect().status.state, 'missing');
      adapter.close();
    } finally {
      removeTempDir(dir);
    }
  });

  it('reports an unreadable database when the file cannot be opened', (context) => {
    if (process.getuid?.() === 0) {
      context.skip('running as root: permission bits are not enforced');
      return;
    }
    const dir = createTempDir();
    try {
      const path = join(dir, 'unreadable.db');
      createCompatibleDatabase(path);
      chmodSync(path, 0o000);
      const adapter = adapterFor(path);
      assert.equal(adapter.inspect().status.state, 'unreadable');
      adapter.close();
      chmodSync(path, 0o600);
    } finally {
      removeTempDir(dir);
    }
  });

  it('distinguishes a corrupt file from a missing one', () => {
    const dir = createTempDir();
    try {
      const path = join(dir, 'garbage.db');
      createCorruptDatabase(path);
      const adapter = adapterFor(path);
      const inspection = adapter.inspect();
      assert.equal(inspection.status.state, 'corrupt');
      assert.match(inspection.status.message, /not a valid or readable/i);
      adapter.close();
    } finally {
      removeTempDir(dir);
    }
  });

  it('detects corruption inside an otherwise valid schema', () => {
    const dir = createTempDir();
    try {
      const path = join(dir, 'truncated.db');
      createTruncatedDatabase(path);
      const adapter = adapterFor(path);
      const inspection = adapter.inspect();
      assert.equal(inspection.status.state, 'corrupt', `unexpected state ${inspection.status.state}`);
      adapter.close();
    } finally {
      removeTempDir(dir);
    }
  });

  it('reports an unrelated database as incompatible with the missing tables listed', () => {
    const dir = createTempDir();
    try {
      const path = join(dir, 'unrelated.db');
      createUnrelatedDatabase(path);
      const adapter = adapterFor(path);
      const inspection = adapter.inspect();
      assert.equal(inspection.status.state, 'incompatible');
      assert.equal(inspection.schema.checked, true);
      assert.equal(inspection.schema.supported, false);
      assert.deepEqual([...inspection.schema.missingTables].sort(), ['project', 'session_message', 'session_v2']);
      adapter.close();
    } finally {
      removeTempDir(dir);
    }
  });

  it('lists missing columns when the schema is only partially compatible', () => {
    const dir = createTempDir();
    try {
      const path = join(dir, 'partial.db');
      createDatabaseWithMissingColumns(path);
      const adapter = adapterFor(path);
      const inspection = adapter.inspect();
      assert.equal(inspection.status.state, 'incompatible');
      assert.deepEqual(inspection.schema.missingTables, []);
      const byTable = new Map(inspection.schema.missingColumns.map((entry) => [entry.table, entry.columns]));
      assert.deepEqual([...(byTable.get('session_message') ?? [])], ['data']);
      assert.ok((byTable.get('session_v2') ?? []).includes('fork_session_id'));
      adapter.close();
    } finally {
      removeTempDir(dir);
    }
  });

  it('treats a compatible but empty database as ready with empty results', () => {
    const dir = createTempDir();
    try {
      const path = join(dir, 'empty.db');
      createEmptyCompatibleDatabase(path);
      const adapter = adapterFor(path);
      const inspection = adapter.inspect();
      assert.equal(inspection.status.state, 'ready');
      assert.equal(inspection.schema.supported, true);
      assert.equal(inspection.schema.checked, true);
      assert.deepEqual(inspection.schema.missingTables, []);
      assert.deepEqual(inspection.schema.missingColumns, []);
      // Empty history is ordinary empty data, not an unavailable database.
      assert.equal(countSessions(adapter), 0);
      adapter.close();
    } finally {
      removeTempDir(dir);
    }
  });

  it('reports a compatible database with data as ready', () => {
    const dir = createTempDir();
    try {
      const path = join(dir, 'ready.db');
      createCompatibleDatabase(path);
      const adapter = adapterFor(path);
      assert.equal(adapter.inspect().status.state, 'ready');
      assert.equal(countSessions(adapter), 1);
      adapter.close();
    } finally {
      removeTempDir(dir);
    }
  });

  it('classifies a busy database separately and within the bounded timeout', () => {
    const dir = createTempDir();
    try {
      const path = join(dir, 'busy.db');
      createCompatibleDatabase(path, { journalMode: 'delete' });
      const writer = new DatabaseSync(path);
      writer.exec('BEGIN EXCLUSIVE');

      const adapter = adapterFor(path, 150);
      const startedAt = Date.now();
      const inspection = adapter.inspect();
      const elapsed = Date.now() - startedAt;

      assert.equal(inspection.status.state, 'busy');
      assert.ok(elapsed < 3000, `busy detection took ${String(elapsed)}ms, which is not bounded`);

      // Releasing the lock clears the reported failure; nothing is cached.
      writer.exec('ROLLBACK');
      writer.close();
      assert.equal(adapter.inspect().status.state, 'ready');
      adapter.close();
    } finally {
      removeTempDir(dir);
    }
  });

  it('keeps the busy timeout bounded by default', () => {
    assert.ok(DEFAULT_BUSY_TIMEOUT_MS > 0 && DEFAULT_BUSY_TIMEOUT_MS <= 10_000);
  });
});

describe('read-only enforcement', () => {
  it('rejects SQL writes through the read-only connection', () => {
    const dir = createTempDir();
    try {
      const path = join(dir, 'readonly.db');
      createCompatibleDatabase(path);
      const adapter = adapterFor(path);

      assert.throws(
        () =>
          adapter.withRead((db) => {
            db.exec('CREATE TABLE written_by_dashboard (id INTEGER)');
          }),
        /readonly|read-only/i,
      );

      assert.throws(
        () =>
          adapter.withRead((db) => {
            db.prepare('INSERT INTO session_v2 (id, directory) VALUES (?, ?)').run('injected', '/tmp');
          }),
        /readonly|read-only/i,
      );

      assert.throws(
        () =>
          adapter.withRead((db) => {
            db.exec("UPDATE session_v2 SET title = 'changed'");
          }),
        /readonly|read-only/i,
      );

      adapter.close();
    } finally {
      removeTempDir(dir);
    }
  });

  it('refuses ATTACH and extension loading on the read-only connection', () => {
    const dir = createTempDir();
    try {
      const path = join(dir, 'no-attach.db');
      createCompatibleDatabase(path);
      const adapter = adapterFor(path);

      assert.throws(
        () =>
          adapter.withRead((db) => {
            db.exec("ATTACH DATABASE ':memory:' AS other");
          }),
        /too many attached databases|not authorized|readonly/i,
        'attaching another database must not be possible',
      );

      assert.throws(
        () =>
          adapter.withRead((db) => {
            db.prepare('SELECT load_extension(?) AS loaded').get('/tmp/not-a-real-extension.so');
          }),
        /not authorized/i,
        'extension loading must be disabled',
      );

      adapter.close();
    } finally {
      removeTempDir(dir);
    }
  });

  it('leaves the database bytes and schema unchanged after reads', () => {
    const dir = createTempDir();
    try {
      const path = join(dir, 'stable.db');
      createCompatibleDatabase(path);
      const before = fingerprintFile(path);
      const schemaBefore = schemaFingerprint(path);

      const adapter = adapterFor(path);
      for (let round = 0; round < 3; round += 1) {
        adapter.inspect();
        assert.equal(countSessions(adapter), 1);
        adapter.withRead((db) => db.prepare('SELECT id, title, model, time_created FROM session_v2').all());
        adapter.withRead((db) => db.prepare('SELECT id, data FROM session_message').all());
      }
      adapter.close();

      const after = fingerprintFile(path);
      assert.deepEqual(after, before, 'database bytes changed after read-only access');
      assert.equal(schemaFingerprint(path), schemaBefore, 'database schema changed after read-only access');
      assert.equal(existsSync(`${path}-journal`), false, 'a rollback journal was left behind');
    } finally {
      removeTempDir(dir);
    }
  });

  it('persists no writes even when a read fails inside the transaction', () => {
    const dir = createTempDir();
    try {
      const path = join(dir, 'failed-read.db');
      createCompatibleDatabase(path);
      const before = fingerprintFile(path);

      const adapter = adapterFor(path);
      assert.throws(() => adapter.withRead((db) => db.prepare('SELECT * FROM does_not_exist').all()));
      // A failed statement rolls back, and the next request still works.
      assert.equal(countSessions(adapter), 1);
      adapter.close();

      assert.deepEqual(fingerprintFile(path), before);
    } finally {
      removeTempDir(dir);
    }
  });
});

describe('refresh, retry, and WAL visibility', () => {
  it('recovers on refresh after an initial failed open', () => {
    const dir = createTempDir();
    try {
      const path = join(dir, 'later.db');
      const adapter = adapterFor(path);

      assert.equal(adapter.inspect().status.state, 'missing');
      assert.throws(() => adapter.withRead(() => null), DatabaseUnavailableError);

      createCompatibleDatabase(path);
      assert.equal(adapter.inspect().status.state, 'ready');
      assert.equal(countSessions(adapter), 1);
      adapter.close();
    } finally {
      removeTempDir(dir);
    }
  });

  it('reopens when the database file has been replaced', () => {
    const dir = createTempDir();
    try {
      const path = join(dir, 'replaced.db');
      const replacement = join(dir, 'replacement.db');

      createCompatibleDatabase(path);
      const adapter = adapterFor(path);
      assert.equal(countSessions(adapter), 1);

      createCompatibleDatabase(replacement, { seed: false });
      const writer = new DatabaseSync(replacement);
      insertProject(writer, 'proj-2');
      insertSession(writer, { id: 'ses-a', projectId: 'proj-2' });
      insertSession(writer, { id: 'ses-b', projectId: 'proj-2' });
      writer.close();

      // Rename keeps the replacement's own inode, so the adapter must notice
      // that the configured path now points at a different database.
      renameSync(replacement, path);
      assert.equal(countSessions(adapter), 2);
      adapter.close();
    } finally {
      removeTempDir(dir);
    }
  });

  it('sees committed WAL data without reopening a healthy connection', () => {
    const dir = createTempDir();
    try {
      const path = join(dir, 'wal.db');
      const writer = new DatabaseSync(path);
      writer.exec('PRAGMA journal_mode = WAL');
      applySchema(writer);
      insertProject(writer, 'proj-1');
      insertSession(writer, { id: 'ses-1', projectId: 'proj-1' });
      insertMessage(writer, { id: 'msg-1', sessionId: 'ses-1', type: 'user', seq: 0 });

      const walPath = `${path}-wal`;
      assert.ok(existsSync(walPath), 'expected a WAL sidecar for an uncheckpointed WAL database');
      assert.ok(statSync(walPath).size > 0, 'expected uncheckpointed WAL content');

      const adapter = adapterFor(path);
      assert.equal(adapter.inspect().status.state, 'ready');
      assert.equal(countSessions(adapter), 1);

      // New committed data must be visible through the read-only connection
      // without restarting or reopening it.
      insertSession(writer, { id: 'ses-2', projectId: 'proj-1' });
      insertMessage(writer, { id: 'msg-2', sessionId: 'ses-2', type: 'user', seq: 0 });
      assert.equal(countSessions(adapter), 2);

      insertMessage(writer, { id: 'msg-3', sessionId: 'ses-2', type: 'assistant', seq: 1 });
      const messages = adapter.withRead((db) => Number(db.prepare('SELECT count(*) AS total FROM session_message').get()?.total ?? -1));
      assert.equal(messages, 3);

      writer.close();
      adapter.close();
    } finally {
      removeTempDir(dir);
    }
  });

  it('holds one snapshot per request and reads newer data on the next request', () => {
    const dir = createTempDir();
    try {
      const path = join(dir, 'snapshot.db');
      const writer = new DatabaseSync(path);
      writer.exec('PRAGMA journal_mode = WAL');
      applySchema(writer);
      insertProject(writer, 'proj-1');
      insertSession(writer, { id: 'ses-1', projectId: 'proj-1' });

      const adapter = adapterFor(path);
      let connection: DatabaseSync | undefined;
      const counts: number[] = [];

      adapter.withRead((db) => {
        connection = db;
        counts.push(countRows(db));
        // A commit from another connection while this request is reading.
        insertSession(writer, { id: 'ses-2', projectId: 'proj-1' });
        counts.push(countRows(db));
      });

      assert.deepEqual(counts, [1, 1], 'a request must read one consistent snapshot');

      // The next request starts a fresh transaction: newer data is visible, and
      // the same healthy connection is reused (no reopen, no restart).
      let secondConnection: DatabaseSync | undefined;
      adapter.withRead((db) => {
        secondConnection = db;
      });
      assert.equal(countSessions(adapter), 2);
      assert.equal(secondConnection, connection, 'the read connection should be reused');

      // No transaction may still be open once a request has finished.
      assert.doesNotThrow(() => {
        (connection as DatabaseSync).exec('BEGIN');
        (connection as DatabaseSync).exec('ROLLBACK');
      }, 'a read request left a transaction open');

      writer.close();
      adapter.close();
    } finally {
      removeTempDir(dir);
    }
  });
});

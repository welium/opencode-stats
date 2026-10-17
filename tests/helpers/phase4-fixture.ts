import { DatabaseSync } from 'node:sqlite';
import { applySchema, insertMessage, insertProject, insertSession } from './fixtures.ts';

export const PHASE4_SECRET = 'PRIVATE_PROMPT_REASONING_TOOL_ERROR_CREDENTIAL';
export function setPhase4Catalog(db: DatabaseSync, mode: 'complete' | 'partial' | 'unavailable', rate = 2): void {
  const models: Record<string, unknown> = { priced: { id: 'priced', cost: { input: rate, output: 8, cache_read: .5, cache_write: 3 } } };
  if (mode === 'complete') models['second'] = { id: 'second', cost: { input: rate, output: 8, cache_read: .5, cache_write: 3 } };
  const body = JSON.stringify({ provider: { id: 'provider', models, env: [PHASE4_SECRET] } });
  const value = mode === 'unavailable' ? '{malformed' : JSON.stringify({ updatedAt: 1_700_000_000_000 + rate, digest: PHASE4_SECRET, body });
  db.prepare('INSERT OR REPLACE INTO kv(key, value) VALUES (?, ?)').run('models-dev:catalog', value);
}

export function createPhase4Fixture(path: string, now = Date.now()): void {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  applySchema(db);
  insertProject(db, 'p', 'Synthetic project');
  insertSession(db, { id: 's', projectId: 'p', title: 'Synthetic estimates and errors', timeCreated: now - 100_000, timeUpdated: now - 1000 });
  insertSession(db, { id: 'fork', projectId: 'p', forkSessionId: 's', timeCreated: now - 5000 });
  const tokens = { input: 600, output: 200, reasoning: 50, cache: { read: 300, write: 100 } };
  for (const [index, model] of ['priced', 'second'].entries()) {
    insertMessage(db, { id: `m${index}`, sessionId: 's', type: 'assistant', seq: index,
      timeCreated: now - 10_000 + index,
      data: { model: { providerID: 'provider', id: model }, agent: 'build', cost: 7, tokens,
        error: { name: index === 0 ? 'APIError' : PHASE4_SECRET, message: PHASE4_SECRET, data: PHASE4_SECRET },
        content: [{ type: 'text', text: PHASE4_SECRET }, { type: 'reasoning', text: PHASE4_SECRET },
          { type: 'tool', name: 'shell', state: { status: 'error', input: PHASE4_SECRET, output: PHASE4_SECRET, error: PHASE4_SECRET } }] } });
  }
  // Copied fork history and out-of-range steps must never be priced or counted.
  insertMessage(db, { id: 'copied', sessionId: 'fork', type: 'assistant', seq: 0, timeCreated: now - 10_000,
    data: { model: { providerID: 'provider', id: 'priced' }, tokens, cost: 1000, error: { name: 'APIError' } } });
  insertMessage(db, { id: 'future', sessionId: 's', type: 'assistant', seq: 99, timeCreated: now + 86_400_000,
    data: { model: { providerID: 'provider', id: 'priced' }, tokens, cost: 1000, error: { name: 'APIError' } } });
  setPhase4Catalog(db, 'complete');
  db.close();
}

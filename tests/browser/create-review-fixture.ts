// Synthetic fixture only. Usage: node tests/browser/create-review-fixture.ts /tmp/opencode/repair1/browser.db
import { DatabaseSync } from 'node:sqlite';
import { createPhase4Fixture } from '../helpers/phase4-fixture.ts';
import { insertMessage, insertProject, insertSession } from '../helpers/fixtures.ts';

const path = process.argv[2];
if (!path) throw new Error('Supply a new synthetic database path');
const now = Date.now();
createPhase4Fixture(path, now);
const db = new DatabaseSync(path);
try {
  db.prepare('UPDATE session_message SET data = ? WHERE id = ?').run(JSON.stringify({
    model: { providerID: 'provider', id: 'second' }, agent: 'build', tokens: { input: 100 },
  }), 'm1');
  insertProject(db, 'q', 'Other synthetic project');
  insertSession(db, { id: 'other', projectId: 'q', title: 'Other project session', timeCreated: now - 172_800_000 });
  insertMessage(db, { id: 'other-step', sessionId: 'other', type: 'assistant', seq: 0, timeCreated: now - 86_400_000,
    data: { model: { providerID: 'provider', id: 'priced' }, agent: 'plan', cost: 3,
      tokens: { input: 100, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } } });
} finally {
  db.close();
}

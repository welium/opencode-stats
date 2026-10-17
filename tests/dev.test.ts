import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { it } from 'node:test';
import { createTempDir, removeTempDir } from './helpers/fixtures.ts';

it('exits on an occupied development browser port and releases the API listener and Vite watchers', async () => {
  const dir = createTempDir('opencode-dev-conflict-');
  const holder = createServer();
  holder.listen(0, '127.0.0.1');
  await once(holder, 'listening');
  const browserAddress = holder.address();
  assert.ok(browserAddress && typeof browserAddress !== 'string');
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const apiAddress = reservation.address();
  assert.ok(apiAddress && typeof apiAddress !== 'string');
  await new Promise<void>((done) => reservation.close(() => done()));
  const child = spawn(process.execPath, ['scripts/dev.ts', '--port', String(browserAddress.port),
    '--api-port', String(apiAddress.port), '--db', join(dir, 'missing.db')], {
    cwd: resolve(import.meta.dirname, '..'), timeout: 10_000, killSignal: 'SIGKILL',
  });
  let output = '';
  child.stdout.on('data', (buffer: Buffer) => { output += buffer.toString(); });
  child.stderr.on('data', (buffer: Buffer) => { output += buffer.toString(); });
  try {
    const [code, signal] = await once(child, 'exit');
    assert.equal(signal, null, `must exit without the timeout killing it: ${output}`);
    assert.equal(code, 1, output);
    assert.match(output, /Cannot start the Vite development listener.*already in use/);
    // Neither the occupied browser listener nor the released API port is stolen.
    assert.equal(holder.listening, true);
    reservation.listen(apiAddress.port, '127.0.0.1');
    await once(reservation, 'listening');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await new Promise<void>((done) => holder.close(() => done()));
    if (reservation.listening) await new Promise<void>((done) => reservation.close(() => done()));
    removeTempDir(dir);
  }
});

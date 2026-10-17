/**
 * Phase 1 gate: CLI behaviour.
 *
 * Exercises the real entry point (`node src/server/main.ts`) for help/version,
 * argument validation, loopback default, explicit private-IP and wildcard binds,
 * port conflicts, database selection, and graceful shutdown.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { DEFAULT_HOST, DEFAULT_PORT } from '../src/server/cli.ts';

import type { HealthResponse } from '../src/shared/api.ts';

import { createCompatibleDatabase, createEmptyCompatibleDatabase, createTempDir, removeTempDir } from './helpers/fixtures.ts';
import { PROJECT_ROOT, fetchJson, runCli, startCli } from './helpers/server.ts';

/** A private IPv4 address of this machine, used to prove explicit binds work. */
function findPrivateIpv4(): string | undefined {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' || address.internal) continue;
      const [first = 0, second = 0] = address.address.split('.').map(Number);
      const isPrivate =
        first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
      if (isPrivate) return address.address;
    }
  }
  return undefined;
}

const WARNING_PATTERN = /warn|insecure|expos|unsafe|allowlist|permission required/i;

interface CliFixture {
  dir: string;
  dbPath: string;
  cleanup(): void;
}

/** A synthetic database per test: tests never open the user's live database. */
function cliFixture(): CliFixture {
  const dir = createTempDir();
  const dbPath = join(dir, 'opencode.db');
  createCompatibleDatabase(dbPath);
  return { dir, dbPath, cleanup: () => removeTempDir(dir) };
}

describe('argument handling', () => {
  it('prints help listing every supported flag and exits 0', async () => {
    const result = await runCli(['--help']);
    assert.equal(result.code, 0);
    assert.equal(result.stderr, '');
    for (const flag of ['--host', '--port', '--db', '--help', '--version']) {
      assert.ok(result.stdout.includes(flag), `help output is missing ${flag}`);
    }
    assert.ok(result.stdout.includes(String(DEFAULT_PORT)));
    assert.ok(result.stdout.includes(DEFAULT_HOST));
    // No --open in v1.
    assert.ok(!result.stdout.includes('--open'));
  });

  it('prints the version and exits 0', async () => {
    const result = await runCli(['--version']);
    assert.equal(result.code, 0);
    const pkg = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8')) as { version: string };
    assert.match(result.stdout.trim(), new RegExp(pkg.version));
  });

  it('rejects unknown arguments, including --open, with a usage error', async () => {
    for (const args of [['--bogus'], ['--open'], ['--host']]) {
      const result = await runCli(args);
      assert.equal(result.code, 2, `expected usage error for ${args.join(' ')}`);
      assert.match(result.stderr, /Unknown argument|Missing value/);
      assert.ok(result.stderr.includes('Usage:'), 'usage hint should be written to stderr');
      assert.equal(result.stdout, '');
    }
  });

  it('validates the port range', async () => {
    for (const value of ['not-a-number', '-1', '70000']) {
      const result = await runCli(['--port', value]);
      assert.equal(result.code, 2, `expected usage error for --port ${value}`);
      assert.match(result.stderr, /--port must be an integer between 0 and 65535/);
    }
  });

  it('accepts --flag=value syntax', async () => {
    const result = await runCli(['--port=0', '--help']);
    assert.equal(result.code, 0);
  });
});

describe('listener binds', () => {
  it('defaults to loopback', async () => {
    const fixture = cliFixture();
    try {
      const running = await startCli(['--port', '0', '--db', fixture.dbPath]);
      try {
        assert.match(running.stdout, /listening on http:\/\/127\.0\.0\.1:\d+/);
        const health = await fetchJson(`${running.url}/api/health`);
        assert.equal(health.status, 200);
        assert.equal((health.body as HealthResponse).database.state, 'ready');
        assert.equal(health.headers.get('cache-control'), 'no-store');
      } finally {
        const stopped = await running.stop();
        assert.equal(stopped.code, 0, 'SIGTERM should exit cleanly');
        assert.match(stopped.stdout, /shutting down/);
      }
    } finally {
      fixture.cleanup();
    }
  });

  it('honors an explicit private IPv4 address without warnings', async (context) => {
    const address = findPrivateIpv4();
    if (address === undefined) {
      context.skip('no private IPv4 address is configured on this machine');
      return;
    }
    const fixture = cliFixture();
    try {
      const running = await startCli(['--host', address, '--port', '0', '--db', fixture.dbPath]);
      try {
        assert.ok(running.stdout.includes(`listening on http://${address}:`), 'chosen host was not used as given');
        assert.ok(!WARNING_PATTERN.test(running.stdout), `unexpected warning in output: ${running.stdout}`);
        const response = await fetchJson(`http://${address}:${String(running.port)}/api/health`);
        assert.equal(response.status, 200);
      } finally {
        await running.stop();
      }
    } finally {
      fixture.cleanup();
    }
  });

  it('honors 0.0.0.0 without substituting or warning', async () => {
    const fixture = cliFixture();
    try {
      const running = await startCli(['--host', '0.0.0.0', '--port', '0', '--db', fixture.dbPath]);
      try {
        assert.match(running.stdout, /listening on http:\/\/0\.0\.0\.0:\d+/);
        assert.ok(!running.stdout.includes('127.0.0.1'), 'the wildcard choice must not be replaced by loopback');
        assert.ok(!WARNING_PATTERN.test(running.stdout), `unexpected warning in output: ${running.stdout}`);
        const health = await fetchJson(`http://127.0.0.1:${String(running.port)}/api/health`);
        assert.equal(health.status, 200);
      } finally {
        await running.stop();
      }
    } finally {
      fixture.cleanup();
    }
  });

  it('honors the IPv6 wildcard address', async () => {
    const fixture = cliFixture();
    try {
      const running = await startCli(['--host', '::', '--port', '0', '--db', fixture.dbPath]);
      try {
        assert.ok(running.stdout.includes('listening on http://[::]:'), 'IPv6 wildcard must be reported verbatim');
        const health = await fetchJson(`http://[::1]:${String(running.port)}/api/health`);
        assert.equal(health.status, 200);
      } finally {
        await running.stop();
      }
    } finally {
      fixture.cleanup();
    }
  });

  it('fails clearly on a port conflict without touching the existing listener', async () => {
    const fixture = cliFixture();
    try {
      const running = await startCli(['--port', '0', '--db', fixture.dbPath]);
      try {
        const conflict = await runCli(['--port', String(running.port), '--db', fixture.dbPath]);
        assert.equal(conflict.code, 1);
        assert.match(conflict.stderr, /address already in use/);
        assert.match(conflict.stderr, new RegExp(String(running.port)));
        assert.match(conflict.stderr, /--port/);

        // The original process keeps serving requests.
        const health = await fetchJson(`${running.url}/api/health`);
        assert.equal(health.status, 200);
      } finally {
        await running.stop();
      }
    } finally {
      fixture.cleanup();
    }
  });
});

describe('database selection', () => {
  it('reads the database given by --db', async () => {
    const dir = createTempDir();
    try {
      const databasePath = join(dir, 'synthetic.db');
      createCompatibleDatabase(databasePath);
      const running = await startCli(['--port', '0', '--db', databasePath]);
      try {
        const response = await fetchJson(`${running.url}/api/health`);
        assert.equal(response.status, 200);
        const body = response.body as HealthResponse;
        assert.equal(body.status, 'ok');
        assert.equal(body.database.path, databasePath);
        assert.equal(body.database.pathSource, 'flag');
        assert.equal(body.schema.supported, true);
      } finally {
        await running.stop();
      }
    } finally {
      removeTempDir(dir);
    }
  });

  it('distinguishes missing from empty-compatible through the real CLI', async () => {
    const dir = createTempDir();
    try {
      const emptyPath = join(dir, 'empty.db');
      createEmptyCompatibleDatabase(emptyPath);

      const empty = await startCli(['--port', '0', '--db', emptyPath]);
      try {
        const response = await fetchJson(`${empty.url}/api/health`);
        assert.equal(response.status, 200, 'an empty compatible database is available, not missing');
        assert.equal((response.body as HealthResponse).database.state, 'ready');
      } finally {
        await empty.stop();
      }

      const missing = await startCli(['--port', '0', '--db', join(dir, 'absent.db')]);
      try {
        const response = await fetchJson(`${missing.url}/api/health`);
        assert.equal(response.status, 503);
        assert.equal((response.body as HealthResponse).database.state, 'missing');
      } finally {
        await missing.stop();
      }
    } finally {
      removeTempDir(dir);
    }
  });

  it('uses OPENCODE_DB when no --db is given', async () => {
    const dir = createTempDir();
    try {
      const databasePath = join(dir, 'from-env.db');
      createCompatibleDatabase(databasePath);
      const running = await startCli(['--port', '0'], { env: { OPENCODE_DB: databasePath, XDG_DATA_HOME: join(dir, 'xdg') } });
      try {
        const body = (await fetchJson(`${running.url}/api/health`)).body as HealthResponse;
        assert.equal(body.database.path, databasePath);
        assert.equal(body.database.pathSource, 'env');
      } finally {
        await running.stop();
      }
    } finally {
      removeTempDir(dir);
    }
  });

  it('falls back to XDG_DATA_HOME for the default path', async () => {
    const dir = createTempDir();
    try {
      const xdg = join(dir, 'xdg-data');
      const running = await startCli(['--port', '0'], {
        env: { OPENCODE_DB: '', XDG_DATA_HOME: xdg },
      });
      try {
        const body = (await fetchJson(`${running.url}/api/health`)).body as HealthResponse;
        assert.equal(body.database.path, join(xdg, 'opencode', 'opencode.db'));
        assert.equal(body.database.pathSource, 'xdg-data-home');
        assert.equal(body.database.state, 'missing');
      } finally {
        await running.stop();
      }
    } finally {
      removeTempDir(dir);
    }
  });
});

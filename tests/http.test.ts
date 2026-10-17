/**
 * Phase 1 gate: HTTP surface.
 *
 * Covers the typed health envelope and its database states, method/route
 * handling (`/api/*` never returns the SPA document), API cache headers, static
 * asset serving, the build-instruction fallback, and path/symlink safety.
 */

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { createDatabaseAdapter } from '../src/server/database.ts';
import { createDashboardServer } from '../src/server/http.ts';

import type { HealthResponse } from '../src/shared/api.ts';
import type { DatabaseAdapter } from '../src/server/database.ts';
import type { RunningServer } from './helpers/server.ts';

import {
  createCompatibleDatabase,
  createEmptyCompatibleDatabase,
  createCorruptDatabase,
  createStaticRootFixture,
  createTempDir,
  createUnrelatedDatabase,
  removeTempDir,
} from './helpers/fixtures.ts';
import { fetchJson, fetchText, rawRequest, startHttpServer } from './helpers/server.ts';

interface Harness {
  server: RunningServer;
  dir: string;
  close(): Promise<void>;
}

async function harnessFor(options: {
  databasePath?: string;
  staticRootMissing?: boolean;
  withIndex?: boolean;
}): Promise<Harness> {
  const dir = createTempDir();
  const databasePath = options.databasePath ?? join(dir, 'opencode.db');
  if (options.databasePath === undefined) createEmptyCompatibleDatabase(databasePath);

  const staticRootFixture = createStaticRootFixture(dir, { withIndex: options.withIndex !== false });
  const staticRoot = options.staticRootMissing === true ? join(dir, 'no-such-build') : staticRootFixture.root;

  const database = createDatabaseAdapter({ path: databasePath, pathSource: 'flag' });
  const server = await startHttpServer(
    createDashboardServer({
      database,
      staticRoot,
      logger: { info: () => undefined, error: () => undefined },
    }),
  );

  return {
    server,
    dir,
    close: async () => {
      await server.close();
      database.close();
      removeTempDir(dir);
    },
  };
}

describe('GET /api/health', () => {
  it('reports a ready database with schema status and no-store headers', async () => {
    const harness = await harnessFor({});
    try {
      const response = await fetchJson(`${harness.server.url}/api/health`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') ?? '', /^application\/json/);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');

      const body = response.body as HealthResponse;
      assert.equal(body.status, 'ok');
      assert.equal(body.database.state, 'ready');
      assert.equal(body.database.pathSource, 'flag');
      assert.equal(body.schema.supported, true);
      assert.equal(body.schema.checked, true);
      assert.equal(body.error, undefined);
      assert.ok(!Number.isNaN(Date.parse(body.generatedAt)), 'generatedAt must be a timestamp');
      assert.equal(new URL(`http:${body.database.path}`).protocol, 'http:', 'database path must be absolute');
    } finally {
      await harness.close();
    }
  });

  it('answers HEAD without a body', async () => {
    const harness = await harnessFor({});
    try {
      const response = await fetch(`${harness.server.url}/api/health`, { method: 'HEAD' });
      assert.equal(response.status, 200);
      assert.equal(await response.text(), '');
      assert.equal(response.headers.get('cache-control'), 'no-store');
    } finally {
      await harness.close();
    }
  });

  it('reports a missing database as unavailable, not as empty history', async () => {
    const dir = createTempDir();
    try {
      const harness = await harnessFor({ databasePath: join(dir, 'absent.db') });
      try {
        const response = await fetchJson(`${harness.server.url}/api/health`);
        assert.equal(response.status, 503);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        const body = response.body as HealthResponse;
        assert.equal(body.status, 'unavailable');
        assert.equal(body.database.state, 'missing');
        assert.equal(body.schema.checked, false);
        assert.equal(body.error?.code, 'database_unavailable');
      } finally {
        await harness.close();
      }
    } finally {
      removeTempDir(dir);
    }
  });

  it('reports an incompatible schema as unavailable with the missing tables', async () => {
    const dir = createTempDir();
    try {
      const databasePath = join(dir, 'unrelated.db');
      createUnrelatedDatabase(databasePath);
      const harness = await harnessFor({ databasePath });
      try {
        const response = await fetchJson(`${harness.server.url}/api/health`);
        assert.equal(response.status, 503);
        const body = response.body as HealthResponse;
        assert.equal(body.database.state, 'incompatible');
        assert.equal(body.schema.supported, false);
        assert.equal(body.schema.checked, true);
        assert.deepEqual([...body.schema.missingTables].sort(), ['project', 'session_message', 'session_v2']);
      } finally {
        await harness.close();
      }
    } finally {
      removeTempDir(dir);
    }
  });

  it('reports a corrupt database separately from a missing one', async () => {
    const dir = createTempDir();
    try {
      const databasePath = join(dir, 'corrupt.db');
      createCorruptDatabase(databasePath);
      const harness = await harnessFor({ databasePath });
      try {
        const response = await fetchJson(`${harness.server.url}/api/health`);
        assert.equal(response.status, 503);
        assert.equal((response.body as HealthResponse).database.state, 'corrupt');
      } finally {
        await harness.close();
      }
    } finally {
      removeTempDir(dir);
    }
  });

  it('picks up a database created after a failed open', async () => {
    const dir = createTempDir();
    try {
      const databasePath = join(dir, 'late.db');
      const harness = await harnessFor({ databasePath });
      try {
        assert.equal((await fetchJson(`${harness.server.url}/api/health`)).status, 503);
        createCompatibleDatabase(databasePath);
        const response = await fetchJson(`${harness.server.url}/api/health`);
        assert.equal(response.status, 200);
        assert.equal((response.body as HealthResponse).status, 'ok');
      } finally {
        await harness.close();
      }
    } finally {
      removeTempDir(dir);
    }
  });
});

describe('/api/* routing', () => {
  it('returns JSON, never the SPA document, for unknown API paths', async () => {
    const harness = await harnessFor({});
    try {
      for (const path of ['/api', '/api/stats/unknown', '/api/health/extra']) {
        const response = await fetchText(`${harness.server.url}${path}`);
        assert.equal(response.status, 404, `expected 404 for ${path}`);
        assert.match(response.headers.get('content-type') ?? '', /^application\/json/);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.ok(!response.text.includes('<!doctype'), `SPA document leaked for ${path}`);
        const parsed = JSON.parse(response.text) as { error?: { code?: string } };
        assert.equal(parsed.error?.code, 'not_found');
      }

      // A traversal-shaped request target that still starts as `/api/...` must
      // be answered with JSON, not routed to the SPA fallback.
      const raw = await rawRequest(harness.server.port, 'GET /api/../health HTTP/1.1');
      assert.match(raw.headers['content-type'] ?? '', /^application\/json/);
      assert.ok(!raw.body.includes('<!doctype'), 'SPA document leaked for /api/../health');
    } finally {
      await harness.close();
    }
  });

  it('rejects unsupported methods with 405 and an Allow header', async () => {
    const harness = await harnessFor({});
    try {
      const response = await fetchText(`${harness.server.url}/api/health`, { method: 'POST' });
      assert.equal(response.status, 405);
      assert.equal(response.headers.get('allow'), 'GET, HEAD');
      assert.match(response.headers.get('content-type') ?? '', /^application\/json/);
    } finally {
      await harness.close();
    }
  });

  it('answers 500 with a safe envelope when a request fails unexpectedly', async () => {
    const dir = createTempDir();
    const database = {
      path: join(dir, 'opencode.db'),
      pathSource: 'flag',
      inspect() {
        throw new Error('internal detail that must not leak');
      },
      withRead() {
        throw new Error('internal detail that must not leak');
      },
      close() {
        return undefined;
      },
    } as unknown as DatabaseAdapter;

    const server = await startHttpServer(
      createDashboardServer({
        database,
        staticRoot: join(dir, 'dist', 'client'),
        logger: { info: () => undefined, error: () => undefined },
      }),
    );

    try {
      const response = await fetchText(`${server.url}/api/health`);
      assert.equal(response.status, 500);
      assert.match(response.headers.get('content-type') ?? '', /^application\/json/);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const parsed = JSON.parse(response.text) as { error?: { code?: string; message?: string } };
      assert.equal(parsed.error?.code, 'internal_error');
      assert.ok(!response.text.includes('internal detail'), 'internal error detail must not be returned');
      assert.ok(!response.text.includes('at '), 'stack traces must not be returned');
    } finally {
      await server.close();
      removeTempDir(dir);
    }
  });
});

describe('static assets', () => {
  it('serves the built index document at the root', async () => {
    const harness = await harnessFor({});
    try {
      const response = await fetchText(`${harness.server.url}/`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') ?? '', /^text\/html/);
      assert.equal(response.headers.get('cache-control'), 'no-cache');
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.ok(response.text.includes('<div id="root">'));
    } finally {
      await harness.close();
    }
  });

  it('serves hashed assets with a JS content type and immutable caching', async () => {
    const harness = await harnessFor({});
    try {
      const response = await fetchText(`${harness.server.url}/assets/app-abc123.js`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') ?? '', /^text\/javascript/);
      assert.match(response.headers.get('cache-control') ?? '', /immutable/);

      const text = await fetchText(`${harness.server.url}/robots.txt`);
      assert.equal(text.status, 200);
      assert.match(text.headers.get('content-type') ?? '', /^text\/plain/);
    } finally {
      await harness.close();
    }
  });

  it('falls back to the SPA document only for valid non-API navigation', async () => {
    const harness = await harnessFor({});
    try {
      const navigation = await fetchText(`${harness.server.url}/some/spa/route`, {
        headers: { accept: 'text/html,application/xhtml+xml' },
      });
      assert.equal(navigation.status, 200);
      assert.match(navigation.headers.get('content-type') ?? '', /^text\/html/);

      const missingFile = await fetchText(`${harness.server.url}/missing.txt`, {
        headers: { accept: 'text/html' },
      });
      assert.equal(missingFile.status, 404);

      const missingAsset = await fetchText(`${harness.server.url}/assets/missing.js`, {
        headers: { accept: '*/*' },
      });
      assert.equal(missingAsset.status, 404);
    } finally {
      await harness.close();
    }
  });

  it('rejects path traversal, including encoded and traversal-shaped forms', async () => {
    const harness = await harnessFor({});
    try {
      const traversalTargets = [
        '/..%2f..%2fetc%2fpasswd',
        '/assets/%2e%2e%2f%2e%2e%2fpackage.json',
        '/assets/%2e%2e/%2e%2e/package.json',
        '/..%2Fpackage.json',
      ];
      for (const target of traversalTargets) {
        const raw = await rawRequest(harness.server.port, `GET ${target} HTTP/1.1`);
        assert.ok(raw.status === 404 || raw.status === 400, `expected rejection for ${target}, got ${String(raw.status)}`);
        assert.ok(!raw.body.includes('root:'), `system file leaked for ${target}`);
        assert.ok(!raw.body.includes('"name": "opencode-stats-dashboard"'), `project file leaked for ${target}`);
      }

      // Normalized (fetch-encoded) forms must not reach the project either.
      for (const path of ['/../package.json', '/%2e%2e%2fpackage.json', '/assets/../../package.json']) {
        const response = await fetchText(`${harness.server.url}${path}`);
        assert.ok(response.status === 404 || response.status === 400, `expected rejection for ${path}`);
        assert.ok(!response.text.includes('"name": "opencode-stats-dashboard"'), `project file leaked for ${path}`);
      }
    } finally {
      await harness.close();
    }
  });

  it('rejects symlinks that escape the static root but follows ones inside it', async () => {
    const harness = await harnessFor({});
    try {
      const escaping = await fetchText(`${harness.server.url}/escape.txt`);
      assert.equal(escaping.status, 404);
      assert.ok(!escaping.text.includes('outside-the-static-root'), 'file outside the build was served');

      const inside = await fetchText(`${harness.server.url}/assets/alias.js`);
      assert.equal(inside.status, 200);
      assert.match(inside.text, /built asset/);
    } finally {
      await harness.close();
    }
  });

  it('serves a clear build instruction when the client is not built', async () => {
    const harness = await harnessFor({ staticRootMissing: true });
    try {
      const document = await fetchText(`${harness.server.url}/`);
      assert.equal(document.status, 503);
      assert.match(document.text, /npm run build/);

      // Health and API stay usable without the client build.
      const health = await fetchJson(`${harness.server.url}/api/health`);
      assert.equal(health.status, 200);
      assert.equal((health.body as HealthResponse).status, 'ok');
    } finally {
      await harness.close();
    }
  });

  it('reports a root without an index document as unbuilt', async () => {
    const harness = await harnessFor({ withIndex: false });
    try {
      const document = await fetchText(`${harness.server.url}/`);
      assert.equal(document.status, 503);
      assert.match(document.text, /npm run build/);
    } finally {
      await harness.close();
    }
  });

  it('rejects unsupported methods on static paths', async () => {
    const harness = await harnessFor({});
    try {
      const response = await fetchText(`${harness.server.url}/`, { method: 'DELETE' });
      assert.equal(response.status, 405);
      assert.equal(response.headers.get('allow'), 'GET, HEAD');
    } finally {
      await harness.close();
    }
  });
});

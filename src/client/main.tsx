/**
 * Phase 1 client shell: reports `/api/health` (database state and
 * supported-schema status) with an explicit refresh, so an unavailable or
 * missing database is visible and retryable instead of looking like an empty
 * usage history. Later phases replace this view with the dashboard pages.
 */

import { StrictMode, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import type { HealthResponse } from '../shared/api.ts';

import { fetchHealth } from './api.ts';
import './styles.css';

type HealthView =
  | { kind: 'loading' }
  | { kind: 'loaded'; health: HealthResponse }
  | { kind: 'failed'; message: string };

function StatusPill(props: { tone: 'ok' | 'warn' | 'error'; label: string }) {
  const toneClass =
    props.tone === 'ok'
      ? 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200'
      : props.tone === 'warn'
        ? 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200'
        : 'bg-rose-100 text-rose-900 dark:bg-rose-950 dark:text-rose-200';
  return (
    <span className={`inline-block rounded-full px-3 py-1 text-sm font-medium tabular-nums ${toneClass}`}>
      {props.label}
    </span>
  );
}

function DetailRow(props: { label: string; value: string }) {
  return (
    <div className="flex gap-3 border-b border-neutral-200 py-2 text-sm last:border-b-0 dark:border-neutral-800">
      <dt className="w-40 shrink-0 text-neutral-500 dark:text-neutral-400">{props.label}</dt>
      <dd className="min-w-0 break-words font-mono text-neutral-900 dark:text-neutral-100">{props.value}</dd>
    </div>
  );
}

function HealthPanel(props: { view: HealthView }) {
  if (props.view.kind === 'loading') {
    return <p className="text-sm text-neutral-500 dark:text-neutral-400">Reading health…</p>;
  }
  if (props.view.kind === 'failed') {
    return (
      <div className="space-y-2">
        <StatusPill tone="error" label="Request failed" />
        <p className="text-sm text-neutral-700 dark:text-neutral-300">{props.view.message}</p>
      </div>
    );
  }

  const { health } = props.view;
  const { database, schema } = health;
  const unavailable = health.status === 'unavailable';

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <StatusPill tone={unavailable ? 'warn' : 'ok'} label={unavailable ? 'Database unavailable' : 'Database available'} />
        <span className="text-sm text-neutral-500 dark:text-neutral-400">Read-only</span>
      </div>

      {unavailable && health.error !== undefined ? (
        <p className="rounded-md bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">
          {health.error.message}
        </p>
      ) : null}

      <dl className="rounded-md border border-neutral-200 px-4 py-2 dark:border-neutral-800">
        <DetailRow label="State" value={database.state} />
        <DetailRow label="Database" value={database.path} />
        <DetailRow label="Path source" value={database.pathSource} />
        <DetailRow label="Schema supported" value={schema.checked ? String(schema.supported) : 'not checked'} />
        <DetailRow
          label="Missing tables"
          value={schema.missingTables.length > 0 ? schema.missingTables.join(', ') : '—'}
        />
        <DetailRow
          label="Missing columns"
          value={
            schema.missingColumns.length > 0
              ? schema.missingColumns.map((entry) => `${entry.table}(${entry.columns.join(', ')})`).join('; ')
              : '—'
          }
        />
        {database.detail !== undefined ? <DetailRow label="Detail" value={database.detail} /> : null}
        <DetailRow label="Generated at" value={health.generatedAt} />
      </dl>
    </div>
  );
}

function App() {
  const [view, setView] = useState<HealthView>({ kind: 'loading' });
  const [inFlight, setInFlight] = useState(false);
  const inFlightRequest = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    // Cancel an older in-flight read so it cannot overwrite a fresher result.
    inFlightRequest.current?.abort();
    const controller = new AbortController();
    inFlightRequest.current = controller;
    setInFlight(true);
    try {
      const health = await fetchHealth(controller.signal);
      if (!controller.signal.aborted) setView({ kind: 'loaded', health });
    } catch (error) {
      if (!controller.signal.aborted) {
        setView({ kind: 'failed', message: error instanceof Error ? error.message : 'Request failed' });
      }
    } finally {
      if (inFlightRequest.current === controller) {
        inFlightRequest.current = null;
        setInFlight(false);
      }
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <main className="mx-auto max-w-3xl space-y-6 p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-neutral-900 dark:text-neutral-50">OpenCode Stats Dashboard</h1>
          <p className="text-sm text-neutral-500 dark:text-neutral-400">Local, read-only OpenCode usage statistics.</p>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={inFlight}
          className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium text-neutral-900 hover:bg-neutral-100 focus-visible:ring-2 focus-visible:ring-offset-2 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-100 dark:hover:bg-neutral-800"
        >
          {inFlight ? 'Refreshing…' : 'Refresh'}
        </button>
      </header>

      <section aria-live="polite" className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
          Data source health
        </h2>
        <HealthPanel view={view} />
      </section>
    </main>
  );
}

const container = document.getElementById('root');
if (container === null) throw new Error('Missing #root element');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

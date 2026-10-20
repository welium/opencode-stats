/**
 * Sessions page: search over title and ID, bounded pagination, and sortable
 * columns backed by the server's allowlisted sort keys.
 *
 * Plan references: §6 "session search covers title/ID, not content", §5
 * "bounded pagination and stable ordering", and §3 "no automatic polling" — the
 * request only changes when a control changes the URL.
 */

import { useEffect, useId, useMemo, useState } from 'react';
import { EstimateValue } from '../components/Estimate.tsx';

import type { SessionListRow } from '../../shared/api.ts';
import type { ColumnSpec } from '../components/ui.tsx';
import type { PageProps } from './types.ts';

import { fetchSessions } from '../api.ts';
import { FilterChip, PageHeader } from '../components/PageHeader.tsx';
import { QueryPanel } from '../components/states.tsx';
import { Badge, Card, SortHeader, ValueCell } from '../components/ui.tsx';
import { formatDateTime, formatInteger, usageValues } from '../format.ts';
import {
  MAX_OFFSET,
  SESSION_PAGE_SIZES,
  SESSION_SORT_KEYS,
  parseLimit,
  parseSessionSort,
  parseSortDir,
  rangeLabel,
  sessionHash,
} from '../route.ts';
import { useQuery } from '../useQuery.ts';

const DEFAULT_LIMIT = 50;

const COLUMNS: readonly ColumnSpec[] = [
  { key: 'title', label: 'Session', initialDir: 'asc' },
  { key: 'updated', label: 'Updated' },
  { key: 'prompts', label: 'Prompts', align: 'right' },
  { key: 'steps', label: 'Steps', align: 'right' },
  { key: 'tokens', label: 'Tokens', align: 'right' },
  { key: 'cost', label: 'Recorded cost', align: 'right' },
];

function sessionColumn(key: string): ColumnSpec | undefined {
  return COLUMNS.find((column) => column.key === key);
}

export function SessionsPage(props: PageProps): React.ReactElement {
  const { rangeKey, refreshToken, route } = props;
  const projectFilter = route.query['projectId'] ?? null;
  const search = route.query['search'] ?? '';
  const sortKey = parseSessionSort(route.query['sort']);
  const dir = parseSortDir(route.query['dir']);
  const limit = parseLimit(route.query['limit'], DEFAULT_LIMIT, SESSION_PAGE_SIZES);
  const offset = Math.min(MAX_OFFSET, Math.max(0, Number.parseInt(route.query['offset'] ?? '0', 10) || 0));

  const searchId = useId();
  const [draft, setDraft] = useState(search);
  // Keep the box in step with back/forward navigation and cleared filters.
  useEffect(() => {
    setDraft(search);
  }, [search]);

  const state = useQuery(
    `sessions:${rangeKey}:${projectFilter ?? ''}:${search}:${sortKey}:${dir}:${limit}:${offset}`,
    refreshToken,
    (signal) =>
      fetchSessions(
        { range: rangeKey, projectId: projectFilter, search, sort: sortKey, dir, limit, offset },
        signal,
      ),
  );

  const rows = state.data?.sessions ?? [];
  const total = state.data?.total ?? 0;
  const firstRow = total === 0 ? 0 : offset + 1;
  const lastRow = offset + rows.length;
  const canGoBack = offset > 0;
  const canGoForward = lastRow < total;

  const pageSizes = useMemo(
    () => SESSION_PAGE_SIZES.map((size) => ({ value: String(size), label: String(size) })),
    [],
  );

  const toggleSort = (key: string, initialDir: 'asc' | 'desc' = 'desc'): void => {
    const normalized = (SESSION_SORT_KEYS as readonly string[]).includes(key) ? key : 'updated';
    const nextDir = normalized === sortKey ? (dir === 'asc' ? 'desc' : 'asc') : initialDir;
    props.setParams({ sort: normalized, dir: nextDir, offset: null });
  };

  return (
    <div className="page">
      <PageHeader
        title="Sessions"
        description={`Sessions with activity in ${rangeLabel(rangeKey).toLowerCase()}, plus their recorded usage.`}
        actions={
          projectFilter === null ? undefined : (
            <FilterChip label="Project" value={projectFilter} onClear={() => props.setParams({ projectId: null, offset: null })} />
          )
        }
      />

      <form
        className="session-controls"
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          props.setParams({ search: draft.trim() === '' ? null : draft.trim(), offset: null });
        }}
      >
        <label className="visually-hidden" htmlFor={searchId}>
          Search sessions by title or session ID
        </label>
        <input
          id={searchId}
          className="input"
          type="search"
          value={draft}
          placeholder="Search title or session ID"
          autoComplete="off"
          onChange={(event) => setDraft(event.target.value)}
        />
        <button type="submit" className="btn">
          Search
        </button>
        {search === '' ? null : (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              setDraft('');
              props.setParams({ search: null, offset: null });
            }}
          >
            Clear search
          </button>
        )}
      </form>

      <QueryPanel
        state={state}
        onRetry={props.onRefresh}
        isEmpty={() => total === 0}
        empty={{
          title: search === '' ? 'No sessions in this range' : 'No sessions match this search',
          message:
            search === ''
              ? 'No sessions have user or assistant activity inside the selected range. Choose a wider range, or press Refresh after new activity.'
              : `Nothing matched “${search}”. Search covers the session title and session ID only, not message text.`,
        }}
      >
        {() => (
          <Card
            title="Session list"
            description={`${formatInteger(firstRow)}–${formatInteger(lastRow)} of ${formatInteger(total)} sessions, sorted by ${labelFor(sortKey)}.`}
            flush
          >
            <div className="table-scroll">
              <table className="data-table">
                <caption className="visually-hidden">Sessions with activity in the selected range</caption>
                <thead>
                  <tr>
                    {COLUMNS.map((column) => (
                      <SortHeader
                        key={column.key}
                        label={column.label}
                        sortKey={column.key}
                        {...(column.align === undefined ? {} : { align: column.align })}
                        active={sortKey === column.key}
                        direction={dir}
                        onSort={(key) => toggleSort(key, column.initialDir)}
                      />
                    ))}
                    <th scope="col" data-align="right">Cost with estimates</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <SessionRow key={row.id} row={row} route={route} />
                  ))}
                </tbody>
              </table>
            </div>

            <nav className="pager" aria-label="Session pagination">
              <span className="dim num">
                {formatInteger(firstRow)}–{formatInteger(lastRow)} of {formatInteger(total)}
              </span>
              <label className="pager-size">
                <span className="dim">Rows</span>
                <select
                  className="input"
                  value={String(limit)}
                  onChange={(event) => props.setParams({ limit: event.target.value, offset: null })}
                >
                  {pageSizes.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="btn"
                disabled={!canGoBack}
                onClick={() => props.setParams({ offset: String(Math.max(0, offset - limit)) })}
              >
                Previous
              </button>
              <button
                type="button"
                className="btn"
                disabled={!canGoForward}
                onClick={() => props.setParams({ offset: String(offset + limit) })}
              >
                Next
              </button>
            </nav>
          </Card>
        )}
      </QueryPanel>
    </div>
  );
}

function labelFor(key: string): string {
  return sessionColumn(key)?.label.toLowerCase() ?? key;
}

function SessionRow(props: { row: SessionListRow; route: PageProps['route'] }): React.ReactElement {
  const { row } = props;
  const values = usageValues(row.usage);
  return (
    <tr>
      <th scope="row" data-wrap="true">
        <a className="link" href={sessionHash(props.route, row.id)}>
          {row.title}
        </a>
        <span className="cell-secondary">
          <span className="mono">{row.id}</span>
          {row.isSubagent ? <Badge tone="neutral">subagent</Badge> : null}
          {row.projectLabel === '' ? null : <span>{row.projectLabel}</span>}
        </span>
      </th>
      <td className="num dim">{formatDateTime(row.timeUpdated)}</td>
      <td data-align="right" className="num">{formatInteger(row.prompts)}</td>
      <td data-align="right" className="num">{formatInteger(row.steps)}</td>
      <td data-align="right"><ValueCell value={values.tokens} /></td>
      <td data-align="right"><ValueCell value={values.cost} /></td>
      <td data-align="right"><EstimateValue estimate={row.estimate} /></td>
    </tr>
  );
}

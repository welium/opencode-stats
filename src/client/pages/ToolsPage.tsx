/**
 * Tools page: tool call outcomes, failure rate, and duration percentiles.
 *
 * Plan references: §4 "Tool outcomes" (`completed` = succeeded, `error` =
 * failed, everything else unfinished), "Tool failure rate" (no denominator means
 * unavailable), and "Duration percentiles" (p50 median, p95 nearest rank) — all
 * of which arrive precomputed, so this page only presents them. §6 forbids
 * color-only status, so every outcome is labelled with text and a count.
 */

import { useMemo } from 'react';

import type { ToolUsageRow } from '../../shared/api.ts';
import type { ColumnSpec } from '../components/ui.tsx';
import type { SortValue } from '../components/sorting.ts';
import type { PageProps } from './types.ts';

import { fetchTools } from '../api.ts';
import { ShareBar } from '../components/charts.tsx';
import { FilterChip, PageHeader } from '../components/PageHeader.tsx';
import { sortRows, useSort } from '../components/sorting.ts';
import { QueryPanel } from '../components/states.tsx';
import { Card, SortRow, Stat } from '../components/ui.tsx';
import { UNAVAILABLE, formatDuration, formatInteger, formatPercent } from '../format.ts';
import { rangeLabel } from '../route.ts';
import { useQuery } from '../useQuery.ts';

const COLUMNS: readonly ColumnSpec[] = [
  { key: 'tool', label: 'Tool', initialDir: 'asc' },
  { key: 'calls', label: 'Calls', align: 'right' },
  { key: 'succeeded', label: 'Succeeded', align: 'right' },
  { key: 'failed', label: 'Failed', align: 'right' },
  { key: 'unfinished', label: 'Unfinished', align: 'right' },
  { key: 'failureRate', label: 'Failure rate', align: 'right' },
  { key: 'p50', label: 'p50', align: 'right' },
  { key: 'p95', label: 'p95', align: 'right' },
];

const OUTCOME_COLORS = {
  succeeded: 'var(--chart-3)',
  failed: 'var(--chart-6)',
  unfinished: 'var(--chart-5)',
} as const;

function sortValue(row: ToolUsageRow, key: string): SortValue {
  switch (key) {
    case 'tool':
      return row.name;
    case 'calls':
      return row.calls;
    case 'succeeded':
      return row.succeeded;
    case 'failed':
      return row.failed;
    case 'unfinished':
      return row.unfinished;
    case 'failureRate':
      return row.failureRate;
    case 'p50':
      return row.duration?.p50 ?? null;
    case 'p95':
      return row.duration?.p95 ?? null;
    default:
      return null;
  }
}

export function ToolsPage(props: PageProps): React.ReactElement {
  const { rangeKey, refreshToken, route } = props;
  const projectFilter = route.query['projectId'] ?? null;
  const sort = useSort('calls', 'desc');

  const state = useQuery(
    `tools:${rangeKey}:${projectFilter ?? ''}`,
    refreshToken,
    (signal) => fetchTools({ range: rangeKey, projectId: projectFilter }, signal),
  );
  const rows = useMemo(() => sortRows(state.data?.tools ?? [], sort.sort, sortValue), [state.data, sort.sort]);

  return (
    <div className="page">
      <PageHeader
        title="Tools"
        description={`Tool call outcomes and durations for ${rangeLabel(rangeKey).toLowerCase()}.`}
        actions={
          projectFilter === null ? undefined : (
            <FilterChip label="Project" value={projectFilter} onClear={() => props.setParams({ projectId: null })} />
          )
        }
      />

      <QueryPanel
        state={state}
        onRetry={props.onRefresh}
        isEmpty={(data) => data.totals.calls === 0}
        empty={{
          title: 'No tool calls in this range',
          message: `No tool calls were recorded inside ${rangeLabel(rangeKey).toLowerCase()}. Choose a wider range, or press Refresh after new activity.`,
        }}
      >
        {(data) => {
          const totals = data.totals;
          const outcomeSegments = [
            { key: 'succeeded', label: 'Succeeded', value: totals.succeeded, color: OUTCOME_COLORS.succeeded },
            { key: 'failed', label: 'Failed', value: totals.failed, color: OUTCOME_COLORS.failed },
            { key: 'unfinished', label: 'Unfinished', value: totals.unfinished, color: OUTCOME_COLORS.unfinished },
          ].filter((segment) => segment.value > 0);

          return (
            <>
              <div className="stat-grid">
                <Stat label="Tool calls" value={formatInteger(totals.calls)} />
                <Stat label="Succeeded" value={formatInteger(totals.succeeded)} />
                <Stat
                  label="Failed"
                  value={formatInteger(totals.failed)}
                  hint={`${formatInteger(totals.unfinished)} unfinished`}
                />
                <Stat
                  label="Failure rate"
                  value={formatPercent(totals.failureRate)}
                  title="Failed ÷ (succeeded + failed)"
                />
                <Stat
                  label="p50 duration"
                  value={formatDuration(totals.duration?.p50 ?? null)}
                  hint={totals.duration === null ? 'no terminal call with a valid duration' : `${formatInteger(totals.duration.count)} measured`}
                />
                <Stat label="p95 duration" value={formatDuration(totals.duration?.p95 ?? null)} />
              </div>

              <Card title="Outcomes" description="Every call is counted once: succeeded, failed, or unfinished.">
                <ShareBar title="Tool outcomes" segments={outcomeSegments} />
              </Card>

              <Card title="Tool usage" description="Outcomes and durations per tool name." flush>
                <div className="table-scroll">
                  <table className="data-table">
                    <caption className="visually-hidden">Tool outcomes and durations</caption>
                    <thead>
                      <SortRow columns={COLUMNS} sort={sort.sort} onToggle={sort.toggle} />
                    </thead>
                    <tbody>
                      {rows.map((row) => (
                        <tr key={row.name ?? '\u0000unknown'}>
                          <th scope="row" className="cell-primary">
                            {row.name ?? <span className="dim">Unknown tool</span>}
                          </th>
                          <td data-align="right" className="num">{formatInteger(row.calls)}</td>
                          <td data-align="right" className="num">{formatInteger(row.succeeded)}</td>
                          <td data-align="right" className="num">{formatInteger(row.failed)}</td>
                          <td data-align="right" className="num">{formatInteger(row.unfinished)}</td>
                          <td data-align="right" className="num" data-unavailable={row.failureRate === null}>
                            {formatPercent(row.failureRate)}
                          </td>
                          <td data-align="right" className="num" data-unavailable={row.duration === null}>
                            {row.duration === null ? UNAVAILABLE : formatDuration(row.duration.p50)}
                          </td>
                          <td data-align="right" className="num" data-unavailable={row.duration === null}>
                            {row.duration === null ? UNAVAILABLE : formatDuration(row.duration.p95)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            </>
          );
        }}
      </QueryPanel>
    </div>
  );
}

/**
 * Models page: provider/model usage for the selected range, with the model
 * filter applied by the Overview drill-down.
 *
 * Plan references: §6 "Overview links into filtered model/project/session
 * views" and "Tables are sortable where useful". §4 keeps variants out of the
 * top-level identity and never drops an unknown provider/model into a silent
 * gap, so an unknown identity is labelled rather than hidden.
 */

import { useMemo } from 'react';

import type { ModelUsageRow } from '../../shared/api.ts';
import type { ColumnSpec } from '../components/ui.tsx';
import type { SortValue } from '../components/sorting.ts';
import type { PageProps } from './types.ts';

import { fetchModels } from '../api.ts';
import { DailyActivityChart } from '../components/charts.tsx';
import { FilterChip, PageHeader } from '../components/PageHeader.tsx';
import { EstimateValue } from '../components/Estimate.tsx';
import { sortRows, useSort } from '../components/sorting.ts';
import { QueryPanel } from '../components/states.tsx';
import { Card, SortRow, Stat, ValueCell } from '../components/ui.tsx';
import { UNAVAILABLE, formatInteger, usageValues } from '../format.ts';
import { rangeLabel } from '../route.ts';
import { useQuery } from '../useQuery.ts';

const COLUMNS: readonly ColumnSpec[] = [
  { key: 'model', label: 'Model', initialDir: 'asc' },
  { key: 'steps', label: 'Steps', align: 'right' },
  { key: 'sessions', label: 'Sessions', align: 'right' },
  { key: 'tokens', label: 'Tokens', align: 'right' },
  { key: 'cacheRate', label: 'Cache rate', align: 'right' },
  { key: 'cost', label: 'Recorded cost', align: 'right' },
  { key: 'estimate', label: 'API-equivalent estimate', align: 'right' },
];

function modelLabel(row: ModelUsageRow): string {
  if (row.model === null) return 'Unknown model';
  return row.provider === null ? row.model : `${row.provider}/${row.model}`;
}

function sortValue(row: ModelUsageRow, key: string): SortValue {
  if (key === 'estimate') return row.estimate.cost;
  switch (key) {
    case 'model':
      return modelLabel(row);
    case 'steps':
      return row.steps;
    case 'sessions':
      return row.sessions;
    case 'tokens':
      return row.usage.tokens.total ?? null;
    case 'cacheRate':
      return row.usage.cacheRate;
    case 'cost':
      return row.usage.cost.value ?? null;
    default:
      return null;
  }
}

export function ModelsPage(props: PageProps): React.ReactElement {
  const { rangeKey, refreshToken, route } = props;
  const modelFilter = route.query['model'] ?? null;
  const projectId = route.query['projectId'] ?? null;
  const sort = useSort('tokens', 'desc');

  const state = useQuery(
    `models:${rangeKey}:${modelFilter ?? ''}:${projectId ?? ''}`,
    refreshToken,
    (signal) => fetchModels({ range: rangeKey, model: modelFilter, projectId }, signal),
  );
  const rows = useMemo(() => sortRows(state.data?.models ?? [], sort.sort, sortValue), [state.data, sort.sort]);

  return (
    <div className="page">
      <PageHeader
        title="Models"
        description={`Assistant-step usage per provider/model for ${rangeLabel(rangeKey).toLowerCase()}.`}
        actions={
          <>
            {projectId === null ? null : <FilterChip label="Project" value={projectId} onClear={() => props.setParams({ projectId: null })} />}
            {modelFilter === null ? null : <FilterChip label="Model" value={modelFilter} onClear={() => props.setParams({ model: null })} />}
          </>
        }
      />

      <QueryPanel
        state={state}
        onRetry={props.onRefresh}
        isEmpty={(data) => data.models.length === 0}
        empty={{
          title: modelFilter === null ? 'No model usage in this range' : 'No usage for this model',
          message:
            modelFilter === null
              ? `No assistant steps fall inside ${rangeLabel(rangeKey).toLowerCase()}. Choose a wider range, or press Refresh after new activity.`
              : `No assistant steps for ${modelFilter} fall inside ${rangeLabel(rangeKey).toLowerCase()}. Clear the filter or choose a wider range.`,
        }}
      >
        {(data) => {
          const totals = data.models.reduce(
            (accumulator, row) => ({
              steps: accumulator.steps + row.steps,
              sessions: accumulator.sessions + row.sessions,
            }),
            { steps: 0, sessions: 0 },
          );
          return (
            <>
              <div className="stat-grid">
                <Stat label="Models" value={formatInteger(data.models.length)} />
                <Stat label="Steps" value={formatInteger(totals.steps)} />
                <Stat
                  label="Model sessions"
                  value={formatInteger(totals.sessions)}
                  title="A session is counted once per model it used"
                />
                <Stat
                  label="Range"
                  value={rangeLabel(rangeKey)}
                  hint={`${data.range.timezone}${data.coverage.tokensComplete ? '' : ' · some steps lack token data'}`}
                />
              </div>

              <Card title="Daily activity" description="Tokens recorded per local date for the current selection.">
                <DailyActivityChart points={data.daily} estimates={data.dailyEstimates} metric="tokens" label="Daily tokens" />
              </Card>

              <Card title="Model usage" description="Steps, sessions, and recorded cost per provider/model." flush>
                <div className="table-scroll">
                  <table className="data-table">
                    <caption className="visually-hidden">Usage per provider and model</caption>
                    <thead>
                      <SortRow columns={COLUMNS} sort={sort.sort} onToggle={sort.toggle} />
                    </thead>
                    <tbody>
                      {rows.map((row) => {
                        const values = usageValues(row.usage);
                        return (
                          <tr key={`${row.provider ?? ''}\u0000${row.model ?? ''}`}>
                            <th scope="row" className="cell-primary" data-wrap="true">
                              {row.model === null ? (
                                <span className="dim">{modelLabel(row)}</span>
                              ) : (
                                <>
                                  <span className="cell-primary">{row.model}</span>
                                  <span className="cell-secondary">
                                    {row.provider ?? UNAVAILABLE}
                                  </span>
                                </>
                              )}
                            </th>
                            <td data-align="right" className="num">{formatInteger(row.steps)}</td>
                            <td data-align="right" className="num">{formatInteger(row.sessions)}</td>
                            <td data-align="right"><ValueCell value={values.tokens} /></td>
                            <td data-align="right" className="num" data-unavailable={values.cacheRate === UNAVAILABLE}>
                              {values.cacheRate}
                            </td>
                            <td data-align="right"><ValueCell value={values.cost} /></td>
                            <td data-align="right"><EstimateValue estimate={row.estimate} /></td>
                          </tr>
                        );
                      })}
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

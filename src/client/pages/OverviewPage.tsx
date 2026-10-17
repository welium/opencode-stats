/**
 * Overview page: headline metrics, daily activity, agent breakdown, and drill
 * downs into filtered model, project, and session views.
 *
 * Plan references: §6 "compact KPI grid, usage chart, ranked breakdowns",
 * "Overview links into filtered model/project/session views", and §4's
 * measured-versus-zero rules (unavailable values render as `—`).
 */

import { useMemo, useState } from 'react';

import type { AgentUsageRow, ModelUsageRow, ProjectUsageRow, TokenTotals } from '../../shared/api.ts';
import type { DailyMetric } from '../components/charts.tsx';
import type { ColumnSpec } from '../components/ui.tsx';
import type { SortValue } from '../components/sorting.ts';
import type { PageProps } from './types.ts';

import { fetchModels, fetchOverview, fetchProjects } from '../api.ts';
import { DailyActivityChart, DAILY_METRIC_OPTIONS, METRIC_LABELS, ShareBar } from '../components/charts.tsx';
import { FilterChip, PageHeader } from '../components/PageHeader.tsx';
import { EstimateStat, EstimateValue } from '../components/Estimate.tsx';
import { sortRows, useSort } from '../components/sorting.ts';
import { QueryPanel } from '../components/states.tsx';
import { Card, Segmented, SortRow, Stat, ValueCell } from '../components/ui.tsx';
import { formatCompact, formatInteger, UNAVAILABLE, usageValues } from '../format.ts';
import { pageHash, rangeLabel } from '../route.ts';
import { useQuery } from '../useQuery.ts';

interface OverviewBundle {
  overview: Awaited<ReturnType<typeof fetchOverview>>;
  models: Awaited<ReturnType<typeof fetchModels>>;
  projects: Awaited<ReturnType<typeof fetchProjects>>;
}

type TokenKey = 'input' | 'output' | 'reasoning' | 'cacheRead' | 'cacheWrite';

const TOKEN_CATEGORIES: ReadonlyArray<{ key: TokenKey; label: string; color: string }> = [
  { key: 'input', label: 'Uncached input', color: 'var(--chart-1)' },
  { key: 'cacheRead', label: 'Cache read', color: 'var(--chart-2)' },
  { key: 'cacheWrite', label: 'Cache write', color: 'var(--chart-4)' },
  { key: 'output', label: 'Output', color: 'var(--chart-3)' },
  { key: 'reasoning', label: 'Reasoning', color: 'var(--chart-5)' },
];

const AGENT_COLUMNS: readonly ColumnSpec[] = [
  { key: 'agent', label: 'Agent', initialDir: 'asc' },
  { key: 'steps', label: 'Steps', align: 'right' },
  { key: 'tokens', label: 'Tokens', align: 'right' },
  { key: 'cost', label: 'Recorded cost', align: 'right' },
  { key: 'estimate', label: 'API-equivalent estimate', align: 'right' },
];

const MODEL_COLUMNS: readonly ColumnSpec[] = [
  { key: 'model', label: 'Model', initialDir: 'asc' },
  { key: 'steps', label: 'Steps', align: 'right' },
  { key: 'sessions', label: 'Sessions', align: 'right' },
  { key: 'tokens', label: 'Tokens', align: 'right' },
  { key: 'cost', label: 'Recorded cost', align: 'right' },
  { key: 'estimate', label: 'API-equivalent estimate', align: 'right' },
];

const PROJECT_COLUMNS: readonly ColumnSpec[] = [
  { key: 'project', label: 'Project', initialDir: 'asc' },
  { key: 'sessions', label: 'Sessions', align: 'right' },
  { key: 'steps', label: 'Steps', align: 'right' },
  { key: 'tokens', label: 'Tokens', align: 'right' },
  { key: 'cost', label: 'Recorded cost', align: 'right' },
  { key: 'estimate', label: 'API-equivalent estimate', align: 'right' },
];

/** Top-of-page breakdowns, capped so Overview stays a summary. */
const TOP_ROWS = 6;

function agentSortValue(row: AgentUsageRow, key: string): SortValue {
  if (key === 'estimate') return row.estimate?.cost ?? null;
  switch (key) {
    case 'agent':
      return row.agent;
    case 'steps':
      return row.steps;
    case 'tokens':
      return row.usage.tokens.total ?? null;
    case 'cost':
      return row.usage.cost.value ?? null;
    default:
      return null;
  }
}

function modelLabel(row: ModelUsageRow): string {
  return `${row.provider ?? UNAVAILABLE} / ${row.model ?? UNAVAILABLE}`;
}

function modelSortValue(row: ModelUsageRow, key: string): SortValue {
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
    case 'cost':
      return row.usage.cost.value ?? null;
    default:
      return null;
  }
}

function projectSortValue(row: ProjectUsageRow, key: string): SortValue {
  if (key === 'estimate') return row.estimate.cost;
  switch (key) {
    case 'project':
      return row.label;
    case 'sessions':
      return row.sessions;
    case 'steps':
      return row.steps;
    case 'tokens':
      return row.usage.tokens.total ?? null;
    case 'cost':
      return row.usage.cost.value ?? null;
    default:
      return null;
  }
}

/** Only categories with a measured, nonzero value take part in the mix. */
function tokenMix(tokens: TokenTotals): Array<{ key: string; label: string; color: string; value: number }> {
  const segments: Array<{ key: string; label: string; color: string; value: number }> = [];
  for (const category of TOKEN_CATEGORIES) {
    const value = tokens[category.key].value ?? 0;
    if (value > 0) segments.push({ key: category.key, label: category.label, color: category.color, value });
  }
  return segments;
}

export function OverviewPage(props: PageProps): React.ReactElement {
  const { rangeKey, refreshToken, route } = props;
  const projectId = route.query['projectId'] ?? null;
  const [metric, setMetric] = useState<DailyMetric>('steps');
  const agentSort = useSort('tokens', 'desc');
  const modelSort = useSort('tokens', 'desc');
  const projectSort = useSort('tokens', 'desc');

  const state = useQuery<OverviewBundle>(`overview:${rangeKey}:${projectId ?? ''}`, refreshToken, async (signal) => {
    const [overview, models, projects] = await Promise.all([
      fetchOverview({ range: rangeKey, projectId }, signal),
      fetchModels({ range: rangeKey, projectId }, signal),
      fetchProjects({ range: rangeKey, projectId }, signal),
    ]);
    return { overview, models, projects };
  });

  const agents = useMemo(() => sortRows(state.data?.overview.agents ?? [], agentSort.sort, agentSortValue), [state.data, agentSort.sort]);
  const models = useMemo(() => sortRows(state.data?.models.models ?? [], modelSort.sort, modelSortValue), [state.data, modelSort.sort]);
  const projects = useMemo(
    () => sortRows(state.data?.projects.projects ?? [], projectSort.sort, projectSortValue),
    [state.data, projectSort.sort],
  );

  return (
    <div className="page">
      <PageHeader
        title="Overview"
        actions={projectId === null ? undefined : <FilterChip label="Project" value={projectId} onClear={() => props.setParams({ projectId: null })} />}
        description={`Assistant usage recorded in the local database for ${rangeLabel(rangeKey).toLowerCase()}.`}
      />

      <QueryPanel
        state={state}
        onRetry={props.onRefresh}
        isEmpty={(data) => data.overview.steps === 0 && data.overview.prompts === 0 && data.overview.sessions.total === 0}
        empty={{
          title: 'No activity in this range',
          message: `No sessions, prompts, or steps fall inside ${rangeLabel(rangeKey).toLowerCase()}. Choose a wider range, or press Refresh after new activity.`,
        }}
      >
        {(data) => {
          const { overview } = data;
          const usage = usageValues(overview.usage);
          const tokens = overview.usage.tokens;
          const mix = tokenMix(tokens);

          return (
            <>
              <div className="stat-grid">
                <Stat label="Recorded cost" value={usage.cost.text} partial={usage.cost.partial} />
                <EstimateStat estimate={overview.estimate} />
                <Stat
                  label="Sessions"
                  value={formatInteger(overview.sessions.total)}
                  hint={`${formatInteger(overview.sessions.root)} root · ${formatInteger(overview.sessions.subagent)} subagent`}
                />
                <Stat label="Prompts" value={formatInteger(overview.prompts)} />
                <Stat
                  label="Steps"
                  value={formatInteger(overview.steps)}
                  hint={`${formatInteger(overview.assistantErrors)} with errors`}
                />
                <Stat
                  label="Tokens"
                  value={usage.tokens.text}
                  partial={usage.tokens.partial}
                  hint={`${formatCompact(tokens.input.value)} input · ${formatCompact(tokens.output.value)} output`}
                />
                <Stat
                  label="Cache rate"
                  value={usage.cacheRate}
                  title="Cache read ÷ (input + cache read + cache write)"
                />
                <Stat
                  label="Active days"
                  value={formatInteger(overview.activity.activeDays)}
                  hint={`longest streak ${formatInteger(overview.activity.longestStreak)} d`}
                />
                <Stat label="Assistant errors" value={formatInteger(overview.assistantErrors)} />
              </div>

              <Card
                title="Daily activity"
                description={`${METRIC_LABELS[metric]} per local date (${overview.range.timezone}).`}
                actions={
                  <Segmented
                    name="overview-metric"
                    label="Chart metric"
                    value={metric}
                    options={DAILY_METRIC_OPTIONS}
                    onChange={setMetric}
                    size="sm"
                  />
                }
              >
                <DailyActivityChart points={overview.daily} estimates={overview.dailyEstimates} metric={metric} label={`Daily ${METRIC_LABELS[metric].toLowerCase()}`} />
              </Card>

              <div className={mix.length === 0 ? '' : 'grid-two'}>
                {mix.length === 0 ? null : (
                  <Card title="Token mix" description="Share of each recorded token category.">
                    <ShareBar title="Token mix" segments={mix} />
                  </Card>
                )}

                <Card title="By agent" description="Assistant steps grouped by the agent recorded on the step.">
                  {agents.length === 0 ? (
                    <p className="dim">No steps in this range.</p>
                  ) : (
                    <div className="table-scroll">
                      <table className="data-table">
                        <caption className="visually-hidden">Usage by agent</caption>
                        <thead>
                          <SortRow columns={AGENT_COLUMNS} sort={agentSort.sort} onToggle={agentSort.toggle} />
                        </thead>
                        <tbody>
                          {agents.map((row) => {
                            const values = usageValues(row.usage);
                            return (
                              <tr key={row.agent ?? '\u0000unknown'}>
                                <th scope="row" className="cell-primary">
                                  {row.agent ?? 'Unknown agent'}
                                </th>
                                <td data-align="right" className="num">{formatInteger(row.steps)}</td>
                                <td data-align="right"><ValueCell value={values.tokens} /></td>
                                <td data-align="right"><ValueCell value={values.cost} /></td>
                                <td data-align="right"><EstimateValue estimate={row.estimate} /></td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </Card>
              </div>

              <Card
                title="Models"
                description="Top models by assistant-step usage."
                actions={<a className="link" href={pageHash(route, 'models')}>All models</a>}
              >
                {models.length === 0 ? (
                  <p className="dim">No model usage in this range.</p>
                ) : (
                  <div className="table-scroll">
                    <table className="data-table">
                      <caption className="visually-hidden">Top models by usage</caption>
                      <thead>
                        <SortRow columns={MODEL_COLUMNS} sort={modelSort.sort} onToggle={modelSort.toggle} />
                      </thead>
                      <tbody>
                        {models.slice(0, TOP_ROWS).map((row) => {
                          const values = usageValues(row.usage);
                          const filter =
                            row.model === null ? null : row.provider === null ? row.model : `${row.provider}/${row.model}`;
                          return (
                            <tr key={`${row.provider ?? ''}/${row.model ?? ''}`}>
                              <th scope="row" className="cell-primary">
                                {filter === null ? (
                                  modelLabel(row)
                                ) : (
                                  <a className="link" href={pageHash(route, 'models', { model: filter })}>
                                    {modelLabel(row)}
                                  </a>
                                )}
                              </th>
                              <td data-align="right" className="num">{formatInteger(row.steps)}</td>
                              <td data-align="right" className="num">{formatInteger(row.sessions)}</td>
                              <td data-align="right"><ValueCell value={values.tokens} /></td>
                              <td data-align="right"><ValueCell value={values.cost} /></td>
                              <td data-align="right"><EstimateValue estimate={row.estimate} /></td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>

              <Card
                title="Projects"
                description="Top projects by assistant-step usage."
                actions={<a className="link" href={pageHash(route, 'projects')}>All projects</a>}
              >
                {projects.length === 0 ? (
                  <p className="dim">No project usage in this range.</p>
                ) : (
                  <div className="table-scroll">
                    <table className="data-table">
                      <caption className="visually-hidden">Top projects by usage</caption>
                      <thead>
                        <SortRow columns={PROJECT_COLUMNS} sort={projectSort.sort} onToggle={projectSort.toggle} />
                      </thead>
                      <tbody>
                        {projects.slice(0, TOP_ROWS).map((row) => (
                          <tr key={row.projectId ?? '\u0000unknown'}>
                            <th scope="row" className="cell-primary">
                              {row.projectId === null ? (
                                row.label
                              ) : (
                                <a className="link" href={pageHash(route, 'sessions', { projectId: row.projectId })}>
                                  {row.label}
                                </a>
                              )}
                            </th>
                            <td data-align="right" className="num">{formatInteger(row.sessions)}</td>
                            <td data-align="right" className="num">{formatInteger(row.steps)}</td>
                            <td data-align="right"><ValueCell value={usageValues(row.usage).tokens} /></td>
                            <td data-align="right"><ValueCell value={usageValues(row.usage).cost} /></td>
                            <td data-align="right"><EstimateValue estimate={row.estimate} /></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
            </>
          );
        }}
      </QueryPanel>
    </div>
  );
}

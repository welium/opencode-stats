/**
 * Projects page: usage per project for the selected range, with the project
 * filter applied by an Overview drill-down.
 *
 * Plan references: §4 "Project display uses a nonempty name, then worktree
 * basename, then project ID" — labels come from the API — and §6 "Overview
 * links into filtered model/project/session views".
 */

import { useMemo } from 'react';
import { tokenSortValue } from '../../shared/usage.ts';

import type { ProjectUsageRow } from '../../shared/api.ts';
import type { ColumnSpec } from '../components/ui.tsx';
import type { SortValue } from '../components/sorting.ts';
import type { PageProps } from './types.ts';

import { fetchProjects } from '../api.ts';
import { DailyActivityChart } from '../components/charts.tsx';
import { FilterChip, PageHeader } from '../components/PageHeader.tsx';
import { sortRows, useSort } from '../components/sorting.ts';
import { QueryPanel } from '../components/states.tsx';
import { Card, SortRow, Stat, ValueCell } from '../components/ui.tsx';
import { EstimateValue } from '../components/Estimate.tsx';
import { formatInteger, usageValues } from '../format.ts';
import { pageHash, rangeLabel } from '../route.ts';
import { useQuery } from '../useQuery.ts';

const COLUMNS: readonly ColumnSpec[] = [
  { key: 'project', label: 'Project', initialDir: 'asc' },
  { key: 'sessions', label: 'Sessions', align: 'right' },
  { key: 'steps', label: 'Steps', align: 'right' },
  { key: 'tokens', label: 'Tokens', align: 'right' },
  { key: 'cost', label: 'Recorded cost', align: 'right' },
  { key: 'estimate', label: 'Cost with estimates', align: 'right' },
];

function sortValue(row: ProjectUsageRow, key: string): SortValue {
  if (key === 'estimate') return row.estimate.cost;
  switch (key) {
    case 'project':
      return row.label;
    case 'sessions':
      return row.sessions;
    case 'steps':
      return row.steps;
    case 'tokens':
      return tokenSortValue(row.usage.tokens);
    case 'cost':
      return row.usage.cost.value ?? null;
    default:
      return null;
  }
}

export function ProjectsPage(props: PageProps): React.ReactElement {
  const { rangeKey, refreshToken, route } = props;
  const projectFilter = route.query['projectId'] ?? null;
  const sort = useSort('tokens', 'desc');

  const state = useQuery(
    `projects:${rangeKey}:${projectFilter ?? ''}`,
    refreshToken,
    (signal) => fetchProjects({ range: rangeKey, projectId: projectFilter }, signal),
  );
  const rows = useMemo(() => sortRows(state.data?.projects ?? [], sort.sort, sortValue), [state.data, sort.sort]);

  return (
    <div className="page">
      <PageHeader
        title="Projects"
        description={`Assistant-step usage per project for ${rangeLabel(rangeKey).toLowerCase()}.`}
        actions={
          projectFilter === null ? undefined : (
            <FilterChip label="Project" value={projectFilter} onClear={() => props.setParams({ projectId: null })} />
          )
        }
      />

      <QueryPanel
        state={state}
        onRetry={props.onRefresh}
        isEmpty={(data) => data.projects.length === 0}
        empty={{
          title: projectFilter === null ? 'No project usage in this range' : 'No usage for this project',
          message:
            projectFilter === null
              ? `No assistant steps fall inside ${rangeLabel(rangeKey).toLowerCase()}. Choose a wider range, or press Refresh after new activity.`
              : `No assistant steps for this project fall inside ${rangeLabel(rangeKey).toLowerCase()}. Clear the filter or choose a wider range.`,
        }}
      >
        {(data) => (
          <>
            <div className="stat-grid">
              <Stat label="Projects" value={formatInteger(data.projects.length)} />
              <Stat
                label="Sessions"
                value={formatInteger(data.projects.reduce((sum, row) => sum + row.sessions, 0))}
              />
              <Stat label="Steps" value={formatInteger(data.projects.reduce((sum, row) => sum + row.steps, 0))} />
              <Stat
                label="Range"
                value={rangeLabel(rangeKey)}
                hint={`${data.range.timezone}${data.coverage.costComplete ? '' : ' · some steps lack cost'}`}
              />
            </div>

            <Card title="Daily activity" description="Tokens recorded per local date for the current selection.">
              <DailyActivityChart points={data.daily} estimates={data.dailyEstimates} metric="tokens" label="Daily tokens" />
            </Card>

            <Card
              title="Project usage"
              description="Select a project to open its sessions."
              flush
            >
              <div className="table-scroll">
                <table className="data-table">
                  <caption className="visually-hidden">Usage per project</caption>
                  <thead>
                    <SortRow columns={COLUMNS} sort={sort.sort} onToggle={sort.toggle} />
                  </thead>
                  <tbody>
                    {rows.map((row) => {
                      const values = usageValues(row.usage);
                      return (
                        <tr key={row.projectId ?? '\u0000unknown'}>
                          <th scope="row" data-wrap="true">
                            {row.projectId === null ? (
                              <span className="dim">{row.label}</span>
                            ) : (
                              <a className="link" href={pageHash(route, 'sessions', { projectId: row.projectId })}>
                                {row.label}
                              </a>
                            )}
                          </th>
                          <td data-align="right" className="num">{formatInteger(row.sessions)}</td>
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
            </Card>
          </>
        )}
      </QueryPanel>
    </div>
  );
}

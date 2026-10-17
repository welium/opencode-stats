/**
 * Statistical session detail: session-level totals, parent/child navigation,
 * and paginated step and tool metadata in stable `seq, id` order.
 *
 * Plan references: §4 "Session detail defaults to the same range for
 * reconciliation; an explicit 'All session activity' action removes the range.
 * Paginate steps in stable `seq, id` order, and show parent/child navigation
 * independently of the range" and §1's non-goal of transcript rendering — this
 * page shows statistics and tool metadata only, never message content.
 */

import type { SessionDetailResponse, ToolOutcome } from '../../shared/api.ts';
import type { ColumnSpec } from '../components/ui.tsx';
import type { PageProps } from './types.ts';

import { fetchSessionDetail } from '../api.ts';
import { DailyActivityChart } from '../components/charts.tsx';
import { PageHeader } from '../components/PageHeader.tsx';
import { QueryPanel } from '../components/states.tsx';
import { Badge, Card, Segmented, Stat, ValueCell } from '../components/ui.tsx';
import { formatDateTime, formatDuration, formatInteger, usageValues } from '../format.ts';
import {
  MAX_OFFSET,
  STEP_PAGE_SIZES,
  allActivityFromQuery,
  pageHash,
  parseBoundedInteger,
  parseLimit,
  rangeLabel,
  sessionHash,
} from '../route.ts';
import { useQuery } from '../useQuery.ts';

const DEFAULT_STEP_LIMIT = 50;

const STEP_COLUMNS: readonly ColumnSpec[] = [
  { key: 'seq', label: '#' },
  { key: 'time', label: 'Time' },
  { key: 'agent', label: 'Agent' },
  { key: 'model', label: 'Model' },
  { key: 'tokens', label: 'Tokens', align: 'right' },
  { key: 'cost', label: 'Recorded cost', align: 'right' },
  { key: 'errors', label: 'Errors' },
  { key: 'tools', label: 'Tools' },
];

const OUTCOME_LABEL: Readonly<Record<ToolOutcome, string>> = {
  succeeded: 'succeeded',
  failed: 'failed',
  unfinished: 'unfinished',
};

const OUTCOME_TONE: Readonly<Record<ToolOutcome, 'ok' | 'bad' | 'warn'>> = {
  succeeded: 'ok',
  failed: 'bad',
  unfinished: 'warn',
};

export function SessionDetailPage(props: PageProps): React.ReactElement {
  const { rangeKey, refreshToken, route } = props;
  const sessionId = route.sessionId ?? '';
  const allActivity = allActivityFromQuery(route.query);
  const stepLimit = parseLimit(route.query['stepLimit'], DEFAULT_STEP_LIMIT, STEP_PAGE_SIZES);
  const stepOffset = Math.min(
    MAX_OFFSET,
    parseBoundedInteger(route.query['stepOffset'], 0, MAX_OFFSET),
  );
  const requestRange = allActivity ? 'all' : rangeKey;

  const state = useQuery(
    `session:${sessionId}:${requestRange}:${stepLimit}:${stepOffset}`,
    refreshToken,
    (signal) =>
      fetchSessionDetail(sessionId, { range: requestRange, limit: stepLimit, offset: stepOffset }, signal),
  );

  return (
    <div className="page">
      <PageHeader
        title={state.data?.session.title ?? 'Session detail'}
        description={
          <>
            <a className="link" href={pageHash(route, 'sessions')}>
              ← All sessions
            </a>
            {state.data === null ? null : (
              <>
                {` · ${state.data.session.projectLabel}`}
                {state.data.session.model === null ? null : <> · <span className="mono">{state.data.session.model}</span></>}
              </>
            )}
          </>
        }
        actions={
          <Segmented
            name="session-activity"
            label="Session activity range"
            value={allActivity ? 'all' : 'range'}
            options={[
              { value: 'range', label: `Selected range (${rangeLabel(rangeKey)})` },
              { value: 'all', label: 'All session activity' },
            ]}
            onChange={(value) =>
              props.setParams({
                activity: value === 'all' ? 'all' : null,
                stepOffset: null,
              })
            }
            size="sm"
          />
        }
      />

      <QueryPanel state={state} onRetry={props.onRefresh} isEmpty={() => false} empty={{ title: '', message: '' }}>
        {(data) => <SessionBody data={data} props={props} stepLimit={stepLimit} stepOffset={stepOffset} />}
      </QueryPanel>
    </div>
  );
}

function SessionBody(props: {
  data: SessionDetailResponse;
  props: PageProps;
  stepLimit: number;
  stepOffset: number;
}): React.ReactElement {
  const { data } = props;
  const pageProps = props.props;
  const { route } = pageProps;
  const values = usageValues(data.usage);
  const steps = data.steps;
  const firstStep = steps.total === 0 ? 0 : steps.offset + 1;
  const lastStep = steps.offset + steps.entries.length;

  return (
    <>
      <div className="meta-row">
        <span>
          <span className="dim">Created</span> <span className="num">{formatDateTime(data.session.timeCreated)}</span>
        </span>
        <span>
          <span className="dim">Updated</span> <span className="num">{formatDateTime(data.session.timeUpdated)}</span>
        </span>
        <span>
          <span className="dim">Session ID</span> <span className="mono">{data.session.id}</span>
        </span>
        {data.session.isSubagent ? <Badge tone="neutral">subagent</Badge> : null}
        {data.allActivity ? <Badge tone="accent">all session activity</Badge> : null}
      </div>

      {data.usage.steps === 0 ? (
        <div className="state" data-variant="empty" data-compact="true">
          <div className="state-text">
            <p className="state-title">No steps in the selected range</p>
            <p className="state-message">
              This session has no assistant activity in {rangeLabel(data.range.key).toLowerCase()}. Choose
              <strong> All session activity</strong> to include the whole session.
            </p>
          </div>
        </div>
      ) : (
        <>
          <div className="stat-grid">
            <Stat label="Steps" value={formatInteger(data.steps.total)} />
            <Stat label="Prompts" value={formatInteger(data.prompts)} />
            <Stat label="Tokens" value={values.tokens.text} partial={values.tokens.partial} />
            <Stat label="Recorded cost" value={values.cost.text} partial={values.cost.partial} />
            <Stat label="Cache rate" value={values.cacheRate} />
            <Stat
              label="Active days"
              value={formatInteger(data.activity.activeDays)}
              hint={`longest streak ${formatInteger(data.activity.longestStreak)} d`}
            />
          </div>

          <Card title="Daily activity" description={`Assistant steps per local date (${data.range.timezone}).`}>
            <DailyActivityChart points={data.daily} metric="steps" label="Daily assistant steps" />
          </Card>
        </>
      )}

      <Card title="Related sessions" description="Parent and child sessions are listed regardless of the range.">
        {data.parent === null && data.children.length === 0 ? (
          <p className="dim">This session has no parent or child sessions.</p>
        ) : (
          <ul className="related-list">
            {data.parent === null ? null : (
              <li>
                <span className="dim">Parent</span>
                <a className="link" href={sessionHash(route, data.parent.id)}>
                  {data.parent.title}
                </a>
                <span className="mono dim">{data.parent.id}</span>
              </li>
            )}
            {data.children.map((child) => (
              <li key={child.id}>
                <span className="dim">Child</span>
                <a className="link" href={sessionHash(route, child.id)}>
                  {child.title}
                </a>
                <span className="num dim">{formatInteger(child.steps)} steps</span>
                <span className="mono dim">{child.id}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card
        title="Steps"
        description={`${formatInteger(firstStep)}–${formatInteger(lastStep)} of ${formatInteger(steps.total)} assistant steps, in recorded order.`}
        flush
      >
        {steps.entries.length === 0 ? (
          <p className="dim" style={{ padding: '12px 16px' }}>
            No steps on this page.
          </p>
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <caption className="visually-hidden">Assistant steps with token, cost, and tool metadata</caption>
              <thead>
                <tr>
                  {STEP_COLUMNS.map((column) => (
                    <th key={column.key} scope="col" data-align={column.align ?? 'left'}>
                      {column.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {steps.entries.map((step) => {
                  const stepValues = usageValues(step.usage);
                  return (
                    <tr key={step.id}>
                      <td className="num dim">{step.seq === null ? '—' : formatInteger(step.seq)}</td>
                      <td className="num dim">{formatDateTime(step.timeCreated)}</td>
                      <td>{step.agent ?? <span className="dim">unknown</span>}</td>
                      <td className="mono dim">
                        {step.model === null ? '—' : `${step.provider ?? ''}${step.provider === null ? '' : '/'}${step.model}`}
                      </td>
                      <td data-align="right"><ValueCell value={stepValues.tokens} /></td>
                      <td data-align="right"><ValueCell value={stepValues.cost} /></td>
                      <td>{step.hasError ? <Badge tone="bad">error</Badge> : <span className="dim">none</span>}</td>
                      <td>
                        {step.tools.length === 0 ? (
                          <span className="dim">—</span>
                        ) : (
                          <details className="tools-cell">
                            <summary>
                              {formatInteger(step.tools.length)} tool{step.tools.length === 1 ? '' : 's'}
                            </summary>
                            <ul>
                              {step.tools.map((tool, index) => (
                                <li key={`${tool.name ?? ''}:${String(index)}`}>
                                  <span className="cell-primary">{tool.name ?? 'Unknown tool'}</span>
                                  <Badge tone={OUTCOME_TONE[tool.status]}>{OUTCOME_LABEL[tool.status]}</Badge>
                                  <span className="num dim">{formatDuration(tool.durationMs)}</span>
                                </li>
                              ))}
                            </ul>
                          </details>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <nav className="pager" aria-label="Step pagination">
          <span className="dim num">
            {formatInteger(firstStep)}–{formatInteger(lastStep)} of {formatInteger(steps.total)}
          </span>
          <label className="pager-size">
            <span className="dim">Rows</span>
            <select
              className="input"
              value={String(props.stepLimit)}
              onChange={(event) => pageProps.setParams({ stepLimit: event.target.value, stepOffset: null })}
            >
              {STEP_PAGE_SIZES.map((size) => (
                <option key={size} value={String(size)}>
                  {size}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="btn"
            disabled={props.stepOffset === 0}
            onClick={() =>
              pageProps.setParams({ stepOffset: String(Math.max(0, props.stepOffset - props.stepLimit)) })
            }
          >
            Previous
          </button>
          <button
            type="button"
            className="btn"
            disabled={lastStep >= steps.total}
            onClick={() => pageProps.setParams({ stepOffset: String(props.stepOffset + props.stepLimit) })}
          >
            Next
          </button>
        </nav>
      </Card>

      <p className="dim foot-note">
        Showing statistics and tool metadata only. Message content, tool arguments, and tool output are never read
        or displayed.
      </p>
    </>
  );
}

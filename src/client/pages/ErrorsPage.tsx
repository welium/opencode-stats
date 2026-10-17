import { fetchErrors } from '../api.ts';
import { PageHeader, FilterChip } from '../components/PageHeader.tsx';
import { QueryPanel } from '../components/states.tsx';
import { Card, Stat } from '../components/ui.tsx';
import { formatDateTime, formatInteger } from '../format.ts';
import { MAX_OFFSET, parseBoundedInteger, sessionHash } from '../route.ts';
import { useQuery } from '../useQuery.ts';
import type { PageProps } from './types.ts';

export function ErrorsPage(props: PageProps): React.ReactElement {
  const { route, rangeKey, refreshToken } = props;
  const projectId = route.query['projectId'] ?? null;
  const offset = parseBoundedInteger(route.query['offset'], 0, MAX_OFFSET);
  const limit = 50;
  const state = useQuery(`errors:${rangeKey}:${projectId ?? ''}:${offset}`, refreshToken,
    (signal) => fetchErrors({ range: rangeKey, projectId, limit, offset }, signal));
  return <div className="page">
    <PageHeader title="Errors" description="Assistant errors and failed tool calls."
      actions={projectId === null ? undefined : <FilterChip label="Project" value={projectId} onClear={() => props.setParams({ projectId: null, offset: null })} />} />
    <QueryPanel state={state} onRetry={props.onRefresh} isEmpty={(data) => data.total === 0}
      empty={{ title: 'No errors in this range', message: 'Choose a wider range or refresh after new activity.' }}>
      {(data) => <>
        <div className="stat-grid"><Stat label="Assistant errors" value={formatInteger(data.assistantErrors)} /><Stat label="Tool failures" value={formatInteger(data.toolFailures)} /></div>
        <Card title="By type and model" flush>
          <div className="table-scroll"><table className="data-table">
            <caption className="visually-hidden">Error counts by type and model</caption>
            <thead><tr><th scope="col">Source</th><th scope="col">Type / status</th><th scope="col">Model</th><th scope="col" data-align="right">Count</th></tr></thead>
            <tbody>{data.groups.map((group) => <tr key={JSON.stringify([group.kind, group.type, group.provider, group.model])}>
              <td>{group.kind === 'assistant' ? 'Assistant' : 'Tool'}</td><th scope="row">{group.type}</th><td data-wrap="true">{group.provider ?? '—'} / {group.model ?? '—'}</td><td className="num" data-align="right">{formatInteger(group.count)}</td>
            </tr>)}</tbody>
          </table></div>{data.groupsTruncated ? <p className="dim">Top 100 groups</p> : null}
        </Card>
        <Card title="Recent errors" flush>
          <div className="table-scroll"><table className="data-table">
            <caption className="visually-hidden">Errors with session links</caption>
            <thead><tr><th scope="col">Time</th><th scope="col">Source</th><th scope="col">Type / status</th><th scope="col">Session</th></tr></thead>
            <tbody>{data.entries.map((entry, index) => <tr key={`${entry.messageId}:${entry.kind}:${index}`}>
              <td className="num">{formatDateTime(entry.timeCreated)}</td><td>{entry.kind === 'assistant' ? 'Assistant' : 'Tool'}</td><td>{entry.type}</td>
              <td>{entry.sessionId === null ? '—' : <a className="link" href={sessionHash(route, entry.sessionId)}>{entry.sessionId}</a>}</td>
            </tr>)}</tbody>
          </table></div>
          <nav className="pager" aria-label="Error pagination"><span className="dim num">{formatInteger(data.entries.length === 0 ? 0 : offset + 1)}–{formatInteger(data.entries.length === 0 ? 0 : offset + data.entries.length)} of {formatInteger(data.total)}</span>
            <button className="btn" type="button" disabled={offset === 0} onClick={() => props.setParams({ offset: String(Math.max(0, offset - limit)) })}>Previous</button>
            <button className="btn" type="button" disabled={offset + limit >= data.total} onClick={() => props.setParams({ offset: String(offset + limit) })}>Next</button>
          </nav>
        </Card>
      </>}
    </QueryPanel>
  </div>;
}

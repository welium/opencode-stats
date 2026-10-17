/**
 * Hand-built SVG charts and proportional bars.
 *
 * Plan references: §3 "Simple SVG charts are sufficient" with no charting
 * dependency, and §6 "restrained chart colors", "accessible chart summaries",
 * and "Do not rely on color/hover alone". Every chart therefore:
 *
 *  - carries a text summary (`aria-label`) that states totals and the peak day,
 *  - labels its own axes in text rather than relying on hover tooltips,
 *  - keeps a visible caption with the same numbers the bars encode, and
 *  - offers daily details on hover, touch, and keyboard focus, and
 *  - offers the underlying series as a real table for keyboard users.
 *
 * The bar geometry lives in a stretched `viewBox`, while every axis label is
 * HTML positioned over that geometry. Scaling the SVG is what lets the bars fill
 * the available width; keeping the text outside it is what keeps the labels at
 * their real size instead of being squashed with the geometry.
 */

import { useId, useState } from 'react';

import type { CostEstimate, DailyActivityPoint, DailyEstimatePoint } from '../../shared/api.ts';
import { EstimateValue } from './Estimate.tsx';

import { UNAVAILABLE, formatCompact, formatCost, formatInteger, shortDateKey } from '../format.ts';

export type DailyMetric = 'steps' | 'tokens' | 'cost' | 'estimate';

export const DAILY_METRIC_OPTIONS: ReadonlyArray<{ value: DailyMetric; label: string }> = [
  { value: 'steps', label: 'Steps' },
  { value: 'tokens', label: 'Tokens' },
  { value: 'cost', label: 'Cost' },
  { value: 'estimate', label: 'Estimate' },
];

function metricValue(point: DailyActivityPoint, metric: DailyMetric, estimate: CostEstimate | undefined): number | null {
  if (metric === 'steps') return point.steps;
  if (metric === 'estimate') return estimate?.cost ?? null;
  return point[metric];
}

function formatMetric(value: number, metric: DailyMetric): string {
  if (metric === 'cost' || metric === 'estimate') return formatCost(value);
  if (metric === 'tokens') return formatCompact(value);
  return formatInteger(value);
}

export const METRIC_LABELS: Readonly<Record<DailyMetric, string>> = {
  steps: 'Assistant steps',
  tokens: 'Tokens',
  cost: 'Recorded cost',
  estimate: 'API-equivalent estimate',
};

export interface DailyActivityChartProps {
  points: readonly DailyActivityPoint[];
  estimates?: readonly DailyEstimatePoint[];
  metric: DailyMetric;
  height?: number;
  /** Describes the series in the accessible summary, e.g. "Daily assistant steps". */
  label: string;
}

/** Coordinate space width of the bar plot; the height is always 100 units. */
const VIEW_WIDTH = 1000;
const VIEW_HEIGHT = 100;
/** Above this many points the parallel data table is replaced by a note. */
export const MAX_CHART_TABLE_ROWS = 120;

/**
 * Daily series as vertical bars with gridline labels, a visible caption, and an
 * equivalent data table. A day without a measured value draws no bar and is
 * reported in the caption, so an unmeasured day is never shown as zero.
 */
export function DailyActivityChart(props: DailyActivityChartProps): React.ReactElement {
  const { points, metric } = props;
  const height = props.height ?? 200;
  const [tableOpen, setTableOpen] = useState(false);
  const [activeDate, setActiveDate] = useState<string | null>(null);
  const tooltipId = useId();

  const estimates = new Map(props.estimates?.map((point) => [point.date, point.estimate]) ?? []);
  const values = points.map((point) => metricValue(point, metric, estimates.get(point.date)));
  const activeIndex = points.findIndex((point) => point.date === activeDate);
  const activePoint = points[activeIndex];
  const activeEstimate = activePoint === undefined ? undefined : estimates.get(activePoint.date);
  const tokenCoverage = (point: DailyActivityPoint): string => point.tokenCompleteSteps < point.steps
    ? ` (${point.tokens === null ? 'unavailable' : 'partial subtotal'}; ${formatInteger(point.tokenCompleteSteps)}/${formatInteger(point.steps)} steps fully reported)` : '';
  const detailLabel = activePoint === undefined ? undefined : `${activePoint.date}. ${formatInteger(activePoint.steps)} steps. ${formatInteger(activePoint.tokens)} tokens${tokenCoverage(activePoint)}. Recorded cost ${formatCost(activePoint.cost)}. API-equivalent estimate ${formatCost(activeEstimate?.cost)}${activeEstimate?.status === 'partial' ? ', partial subtotal' : ''}.`;

  function selectPointerDay(event: React.PointerEvent<HTMLDivElement>): void {
    const bounds = event.currentTarget.getBoundingClientRect();
    if (bounds.width <= 0) return;
    const index = Math.max(0, Math.min(points.length - 1, Math.floor(((event.clientX - bounds.left) / bounds.width) * points.length)));
    setActiveDate(points[index]?.date ?? null);
  }
  const measured = values.filter((value): value is number => value !== null);
  const missing = values.length - measured.length;
  const totalLabel = metric === 'estimate' && props.estimates?.some((point) => point.estimate.status !== 'complete')
    ? 'Priced subtotal' : missing > 0 || (metric === 'tokens' && points.some((point) => point.tokenCompleteSteps < point.steps)) ? 'Measured subtotal' : 'Total';
  const max = measured.length === 0 ? 0 : Math.max(...measured);
  const total = measured.reduce((sum, value) => sum + value, 0);
  let peakIndex = -1;
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === max && max > 0 && peakIndex === -1) peakIndex = index;
  }

  const slot = points.length === 0 ? VIEW_WIDTH : VIEW_WIDTH / points.length;
  const barWidth = Math.max(4, Math.min(46, slot - 4));

  const gridValues = max <= 0 ? [0] : [max, max / 2, 0];
  const summary =
    measured.length === 0
      ? `${props.label}: no measured values in this range.`
      : `${props.label}: ${totalLabel.toLowerCase()} ${formatMetric(total, metric)} across ${String(measured.length)} day${measured.length === 1 ? '' : 's'}, ${
          peakIndex === -1 ? 'no peak' : `peak ${formatMetric(max, metric)} on ${points[peakIndex]?.date ?? ''}`
        }.${missing > 0 ? ` ${String(missing)} day${missing === 1 ? '' : 's'} have no measured value.` : ''}`;

  const tickIndices = points.length === 0 ? [] : [...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])];

  return (
    <figure className="chart">
      <div className="chart-plot" role="group" aria-label={summary}>
        <div className="chart-axis-y" aria-hidden="true" style={{ height: `${String(height)}px` }}>
          {gridValues.map((gridValue, index) => (
            <span key={`y-${String(index)}`}>{formatMetric(gridValue, metric)}</span>
          ))}
        </div>
        <div
          className="chart-canvas"
          role={points.length === 0 ? undefined : 'slider'}
          tabIndex={points.length === 0 ? undefined : 0}
          aria-label={`${props.label}, daily details`}
          aria-orientation="horizontal"
          aria-valuemin={1}
          aria-valuemax={Math.max(1, points.length)}
          aria-valuenow={Math.max(0, activeIndex) + 1}
          aria-valuetext={detailLabel ?? points[0]?.date}
          aria-describedby={activePoint === undefined ? undefined : tooltipId}
          onPointerMove={selectPointerDay}
          onPointerDown={selectPointerDay}
          onPointerLeave={(event) => {
            if (event.pointerType !== 'touch' && document.activeElement !== event.currentTarget) setActiveDate(null);
          }}
          onFocus={() => setActiveDate((date) => date ?? points[0]?.date ?? null)}
          onBlur={() => setActiveDate(null)}
          onKeyDown={(event) => {
            let index = Math.max(0, activeIndex);
            if (event.key === 'Escape') { setActiveDate(null); return; }
            if (event.key === 'ArrowRight' || event.key === 'ArrowUp') index++;
            else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') index--;
            else if (event.key === 'Home') index = 0;
            else if (event.key === 'End') index = points.length - 1;
            else return;
            event.preventDefault();
            setActiveDate(points[Math.max(0, Math.min(points.length - 1, index))]?.date ?? null);
          }}
        >
          <svg
            viewBox={`0 0 ${String(VIEW_WIDTH)} ${String(VIEW_HEIGHT)}`}
            width="100%"
            height={height}
            preserveAspectRatio="none"
            aria-hidden="true"
            focusable="false"
          >
            {gridValues.map((gridValue, index) => {
              const y = max <= 0 ? VIEW_HEIGHT : VIEW_HEIGHT - (gridValue / max) * VIEW_HEIGHT;
              return <line key={`grid-${String(index)}`} className="chart-grid-line" x1={0} y1={y} x2={VIEW_WIDTH} y2={y} />;
            })}
            {activePoint === undefined ? null : (
              <rect className="chart-day-highlight" x={activeIndex * slot} y={0} width={slot} height={VIEW_HEIGHT} />
            )}
            {points.map((point, index) => {
              const value = values[index];
              if (value === null || value === undefined) return null;
              const barHeight = max <= 0 ? 0 : (value / max) * VIEW_HEIGHT;
              const x = index * slot + (slot - barWidth) / 2;
              return (
                <rect
                  key={point.date}
                  className="chart-bar"
                  x={x}
                  y={VIEW_HEIGHT - barHeight}
                  width={barWidth}
                  height={Math.max(0, barHeight)}
                />
              );
            })}
          </svg>
          <div className="chart-axis-x" aria-hidden="true">
            {tickIndices.map((index) => {
              const point = points[index];
              if (point === undefined) return null;
              return (
                <span key={`tick-${point.date}`} style={{ left: `${String(((index + 0.5) / points.length) * 100)}%` }}>
                  {shortDateKey(point.date)}
                </span>
              );
            })}
          </div>
          {activePoint === undefined ? null : (
            <div
              id={tooltipId}
              role="tooltip"
              className="chart-tooltip"
              style={{ left: `clamp(0px, calc(${String(((activeIndex + 0.5) / points.length) * 100)}% - 120px), max(0px, calc(100% - 240px)))` }}
            >
              <strong>{activePoint.date}</strong>
              <dl>
                <div><dt>Steps</dt><dd>{formatInteger(activePoint.steps)}</dd></div>
                <div><dt>Tokens</dt><dd>{formatInteger(activePoint.tokens)}{tokenCoverage(activePoint)}</dd></div>
                <div><dt>Recorded cost</dt><dd>{formatCost(activePoint.cost)}</dd></div>
                <div><dt>API-equivalent estimate</dt><dd><EstimateValue estimate={activeEstimate} /></dd></div>
              </dl>
            </div>
          )}
        </div>
      </div>

      <figcaption className="chart-caption">
        <span>
          {measured.length === 0
            ? 'No measured values in this range.'
            : `${totalLabel} ${formatMetric(total, metric)} over ${String(measured.length)} measured day${measured.length === 1 ? '' : 's'}.`}
        </span>
        {peakIndex === -1 ? null : (
          <span className="dim">{`Peak ${formatMetric(max, metric)} on ${points[peakIndex]?.date ?? ''}.`}</span>
        )}
        {missing > 0 ? <span className="dim">{`${String(missing)} day${missing === 1 ? '' : 's'} without a measured value.`}</span> : null}
      </figcaption>

      {points.length === 0 ? null : (
        <details className="chart-data" open={tableOpen} onToggle={(event) => setTableOpen(event.currentTarget.open)}>
          <summary>Chart data</summary>
          {points.length > MAX_CHART_TABLE_ROWS ? (
            <p className="dim">
              {`${String(points.length)} days in this range — switch to a shorter range to list every day.`}
            </p>
          ) : (
            <div className="table-scroll">
              <table className="data-table compact">
                <caption className="visually-hidden">{`${props.label} by local date`}</caption>
                <thead>
                  <tr>
                    <th scope="col">Date</th>
                    <th scope="col" data-align="right">
                      {METRIC_LABELS[metric]}
                    </th>
                    {props.estimates === undefined || metric === 'estimate' ? null : <th scope="col" data-align="right">API-equivalent estimate</th>}
                  </tr>
                </thead>
                <tbody>
                  {points.map((point, index) => {
                    const value = values[index];
                    return (
                      <tr key={point.date}>
                        <th scope="row">{point.date}</th>
                        <td data-align="right" className="num">
                           {metric === 'estimate' ? <EstimateValue estimate={estimates.get(point.date)} /> : value === null || value === undefined ? UNAVAILABLE : formatMetric(value, metric)}
                           {metric === 'tokens' ? tokenCoverage(point) : null}
                        </td>
                        {props.estimates === undefined || metric === 'estimate' ? null : <td data-align="right"><EstimateValue estimate={estimates.get(point.date)} /></td>}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </details>
      )}
    </figure>
  );
}

export interface ShareSegment {
  key: string;
  label: string;
  value: number;
  color: string;
}

/**
 * One stacked proportional bar plus a legend that repeats every label and value
 * as text, so the split is readable without color perception or hovering.
 */
export function ShareBar(props: { segments: readonly ShareSegment[]; title: string }): React.ReactElement {
  const total = props.segments.reduce((sum, segment) => sum + (Number.isFinite(segment.value) ? segment.value : 0), 0);
  const described = props.segments.map((segment) => `${segment.label} ${formatInteger(segment.value)}`).join(', ');
  return (
    <div className="share">
      <div className="share-bar" role="img" aria-label={`${props.title}: ${described}`}>
        {props.segments.map((segment) => (
          <span
            key={segment.key}
            className="share-seg"
            style={{
              flexGrow: String(total > 0 ? segment.value / total : 0),
              background: segment.color,
            }}
            aria-hidden="true"
            title={`${segment.label}: ${formatInteger(segment.value)} (${total > 0 ? `${((segment.value / total) * 100).toFixed(1)}%` : UNAVAILABLE})`}
          />
        ))}
      </div>
      <ul className="share-legend">
        {props.segments.map((segment) => (
          <li key={segment.key}>
            <span className="swatch" style={{ background: segment.color }} aria-hidden="true" />
            <span className="share-legend-label">{segment.label}</span>
            <span className="num">{formatInteger(segment.value)}</span>
            <span className="dim num">
              {total > 0 ? `${((segment.value / total) * 100).toFixed(1)}%` : UNAVAILABLE}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

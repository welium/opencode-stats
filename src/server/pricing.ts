/** Preserve recorded costs; price recorded-zero steps offline within the read transaction. */
import type { CostEstimate, EstimateUnpricedReason, PricingCatalogMeta } from '../shared/api.ts';
import type { QueryRunner, StepRow } from './metrics.ts';

type ObjectValue = Record<string, unknown>;
export interface PricingCatalog {
  meta: PricingCatalogMeta;
  providers: ObjectValue | null;
}

function object(value: unknown): ObjectValue | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : null;
}

function own(value: ObjectValue | null, key: string): unknown {
  return value !== null && Object.hasOwn(value, key) ? value[key] : undefined;
}

export function parseCatalog(raw: unknown): PricingCatalog {
  const unavailable: PricingCatalog = { meta: { available: false, updatedAt: null, digest: null }, providers: null };
  if (typeof raw !== 'string') return unavailable;
  try {
    const envelope = object(JSON.parse(raw));
    if (envelope === null || typeof envelope['body'] !== 'string') return unavailable;
    const providers = object(JSON.parse(envelope['body']));
    const timestamp = envelope['updatedAt'];
    if (providers === null || typeof timestamp !== 'number' || !Number.isFinite(timestamp) || !Number.isFinite(new Date(timestamp).getTime())) return unavailable;
    return {
      providers,
      // A digest is not returned: its contents are arbitrary local catalog data.
      meta: { available: true, updatedAt: new Date(timestamp).toISOString(), digest: null },
    };
  } catch {
    return unavailable;
  }
}

export function loadPricingCatalog(runner: QueryRunner): PricingCatalog {
  const table = runner.get<{ name: string }>("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'kv'");
  if (table === undefined) return parseCatalog(null);
  const columns = runner.all<{ name: string }>('PRAGMA table_info(kv)');
  if (!columns.some((column) => column.name === 'key') || !columns.some((column) => column.name === 'value')) return parseCatalog(null);
  const row = runner.get<{ value: unknown }>('SELECT value FROM kv WHERE key = ?', ['models-dev:catalog']);
  return parseCatalog(row?.value);
}

// OpenAI Standard -> Fast price ratios, including cached tokens. Do not infer
// a universal multiplier: older models and GPT-5.5 have different premiums.
// https://developers.openai.com/api/docs/pricing (checked 2026-10-17)
const fastMultipliers: Readonly<Record<string, number>> = {
  'gpt-6-astra': 2, 'gpt-6.1-sol': 2, 'gpt-6-sol': 2, 'gpt-6-luna': 2,
  'gpt-5.6-sol': 2, 'gpt-5.6-terra': 2, 'gpt-5.6-luna': 2,
  'gpt-5.5': 2.5, 'gpt-5.4': 2, 'gpt-5.4-mini': 2,
  'gpt-5.2': 2, 'gpt-5.1': 2, 'gpt-5': 2, 'gpt-5-mini': 1.8,
  'gpt-4.1': 1.75, 'gpt-4.1-mini': 1.75, 'gpt-4.1-nano': 2,
  'gpt-4o': 1.7, 'gpt-4o-2024-05-13': 1.75, 'gpt-4o-mini': 5 / 3,
  'o3': 1.75, 'o4-mini': 20 / 11,
};
const ultrafastMultipliers: Readonly<Record<string, number>> = {
  'gpt-6-astra': 6, 'gpt-6.1-sol': 6,
};

function priceStep(step: StepRow, catalog: PricingCatalog): number | EstimateUnpricedReason {
  // Recorded amounts take precedence over today's catalog, including its tiers.
  // Only an explicit recorded zero opts into API-equivalent pricing.
  if (step.cost === null || !Number.isFinite(step.cost) || step.cost < 0) return 'missing-cost';
  if (step.cost > 0) return step.cost;
  const tokens = [step.input, step.output, step.reasoning, step.cacheRead, step.cacheWrite];
  if (tokens.some((value) => value === null || !Number.isFinite(value) || value < 0)) return 'missing-tokens';
  if (step.provider === null || step.model === null) return 'no-model-price';
  // These suffixes describe billing variants, not separate model identities.
  // A free variant deliberately uses paid base rates, even if catalogued at $0.
  let modelId = step.model;
  if (modelId.endsWith('-free')) modelId = modelId.slice(0, -'-free'.length);
  let multiplier = 1;
  const variant = /-(ultrafast|fast)$/.exec(modelId);
  if (variant !== null) {
    modelId = modelId.slice(0, -variant[0].length);
    const multipliers = variant[1] === 'fast' ? fastMultipliers : ultrafastMultipliers;
    const published = own(multipliers, modelId);
    if (typeof published !== 'number') return 'no-model-price';
    multiplier = published;
  }
  const providerIds = step.provider === 'opencode' ? ['opencode', 'opencode-go']
    : step.provider === 'opencode-go' ? ['opencode-go', 'opencode'] : [step.provider];
  let model: ObjectValue | null = null;
  for (const providerId of providerIds) {
    const entry = own(catalog.providers, providerId);
    if (entry === undefined) continue;
    const provider = object(entry);
    // Conflicting explicit IDs are not aliases, even within the OpenCode pair.
    if (provider?.['id'] !== providerId) return 'no-model-price';
    const candidate = own(object(provider['models']), modelId);
    if (candidate === undefined) continue;
    model = object(candidate);
    if (model?.['id'] !== modelId) return 'no-model-price';
    break;
  }
  if (model === null) return 'no-model-price';
  const base = model['cost'] === undefined ? {} : object(model['cost']);
  if (base === null) return 'no-model-price';
  const input = step.input!;
  const output = step.output! + step.reasoning!;
  const read = step.cacheRead!;
  const write = step.cacheWrite!;
  const context = input + read + write;
  if (!Number.isFinite(context) || !Number.isFinite(output)) return 'missing-tokens';
  let rates = base;
  let threshold = -1;
  const seen = new Set<number>();
  const tiers = base['tiers'];
  if (tiers !== undefined) {
    if (!Array.isArray(tiers)) return 'ambiguous-tier';
    for (const item of tiers) {
      const candidate = object(item);
      const tier = object(candidate?.['tier']);
      const size = tier?.['size'];
      if (candidate === null || tier?.['type'] !== 'context' || typeof size !== 'number' || !Number.isFinite(size) || size < 0) return 'ambiguous-tier';
      if (size >= context) continue;
      for (const name of ['input', 'output', 'cache_read', 'cache_write']) {
        const rate = candidate[name];
        if (rate !== undefined && (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0)) return 'missing-rate';
      }
      if (seen.has(size)) return 'ambiguous-tier';
      seen.add(size);
      if (size > threshold) { rates = candidate; threshold = size; }
    }
  }
  const categories = [[input, 'input'], [output, 'output'], [read, 'cache_read'], [write, 'cache_write']] as const;
  let total = 0;
  for (const [count, name] of categories) {
    const rate = rates[name];
    // An explicit invalid rate is rejected even when this category has no tokens.
    if (rate !== undefined && (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0)) return 'missing-rate';
    if (count === 0) continue;
    if (typeof rate !== 'number') return 'missing-rate';
    total += count * rate;
  }
  const cost = total / 1_000_000 * multiplier;
  return Number.isFinite(cost) ? cost : 'missing-rate';
}

export function estimateCost(steps: readonly StepRow[], catalog: PricingCatalog): CostEstimate {
  let cost = 0;
  let pricedSteps = 0;
  const reasons: CostEstimate['unpricedByReason'] = { 'missing-cost': 0, 'no-model-price': 0, 'missing-tokens': 0, 'missing-rate': 0, 'ambiguous-tier': 0 };
  const models = new Map<string, { provider: string | null; model: string | null; steps: number }>();
  for (const step of steps) {
    const price = priceStep(step, catalog);
    if (typeof price === 'number' && Number.isFinite(cost + price)) { cost += price; pricedSteps++; continue; }
    reasons[typeof price === 'number' ? 'missing-rate' : price]++;
    const key = JSON.stringify([step.provider, step.model]);
    const entry = models.get(key) ?? { provider: step.provider, model: step.model, steps: 0 };
    entry.steps++;
    models.set(key, entry);
  }
  const unpricedModels = [...models.values()].sort((a, b) => b.steps - a.steps || JSON.stringify([a.provider, a.model]).localeCompare(JSON.stringify([b.provider, b.model])));
  const available = pricedSteps > 0 || steps.length === 0;
  return {
    status: !available ? 'unavailable' : pricedSteps === steps.length ? 'complete' : 'partial',
    cost: available ? cost : null,
    steps: steps.length, pricedSteps, unpricedSteps: steps.length - pricedSteps,
    unpricedByReason: reasons, unpricedModels: unpricedModels.slice(0, 50), unpricedModelsTruncated: unpricedModels.length > 50,
    catalog: catalog.meta,
  };
}

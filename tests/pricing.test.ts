import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { estimateCost, parseCatalog } from '../src/server/pricing.ts';
import type { StepRow } from '../src/server/metrics.ts';

function step(overrides: Partial<StepRow> = {}): StepRow {
  return { id: 'a', sessionId: 's', seq: 1, timeCreated: 1, projectId: 'p', unreadable: false,
    cost: 0, input: 600, output: 200, reasoning: 50, cacheRead: 300, cacheWrite: 100,
    provider: 'provider', model: 'model', agent: 'build', hasError: false, ...overrides };
}

function catalog(cost: unknown) {
  return parseCatalog(JSON.stringify({ updatedAt: 1_700_000_000_000, digest: 'test', body: JSON.stringify({ provider: { id: 'provider', models: { model: { id: 'model', cost } } } }) }));
}
const rates = { input: 2, output: 8, cache_read: 0.5, cache_write: 3 };
const zero = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };

function modelCatalog(models: Record<string, unknown>) {
  return parseCatalog(JSON.stringify({ updatedAt: 1_700_000_000_000, body: JSON.stringify({
    provider: { id: 'provider', models: Object.fromEntries(Object.entries(models).map(([id, cost]) => [id, { id, cost }])) },
  }) }));
}

describe('offline estimates', () => {
  it('prices disjoint input, visible output + reasoning, and both cache categories by hand', () => {
    const original = step();
    const result = estimateCost([original], catalog(rates));
    // (600*2 + 250*8 + 300*0.5 + 100*3) / 1e6 = .00365
    assert.equal(result.cost, 0.00365);
    assert.equal(result.status, 'complete');
    assert.equal(result.pricedSteps, 1);
    assert.equal(result.catalog.updatedAt, '2023-11-14T22:13:20.000Z');
    assert.equal(original.cost, 0);
  });

  it('uses positive recorded costs without requiring catalog, model, or token measurements', () => {
    const original = step({ cost: 77, provider: null, model: null, input: null });
    for (const pricing of [parseCatalog(null), catalog(rates)]) {
      const result = estimateCost([original], pricing);
      assert.equal(result.cost, 77);
      assert.equal(result.status, 'complete');
      assert.equal(result.pricedSteps, 1);
    }
    assert.equal(original.cost, 77);
    // A current long-context tier must not reprice a historical paid step.
    assert.equal(estimateCost([step({ cost: .107302, input: 2977, cacheRead: 199936 })],
      catalog({ ...rates, tiers: [{ tier: { type: 'context', size: 200000 }, input: 4, output: 12, cache_read: 1, cache_write: 0 }] })).cost, .107302);
  });

  it('combines recorded paid steps and zero-cost estimates per step, not per model', () => {
    const result = estimateCost([step({ cost: 7 }), step()], catalog(rates));
    assert.equal(result.cost, 7 + .00365);
    assert.equal(result.status, 'complete');
    assert.equal(result.pricedSteps, 2);
    const partial = estimateCost([step({ cost: 7 }), step()], parseCatalog(null));
    assert.equal(partial.cost, 7);
    assert.equal(partial.status, 'partial');
    assert.equal(partial.unpricedByReason['no-model-price'], 1);
    assert.deepEqual(estimateCost([], parseCatalog(null)).status, 'complete');
    assert.equal(estimateCost([], parseCatalog(null)).cost, 0);
  });

  it('does not treat missing or invalid recorded costs as free usage', () => {
    for (const cost of [null, -1, Infinity, NaN]) {
      const result = estimateCost([step({ cost })], catalog(rates));
      assert.equal(result.cost, null);
      assert.equal(result.status, 'unavailable');
      assert.equal(result.unpricedByReason['missing-cost'], 1);
    }
  });

  it('keeps explicit free rates, requires no rates for zero categories, and does not default missing positive rates', () => {
    assert.equal(estimateCost([step()], catalog({ input: 0, output: 0, cache_read: 0, cache_write: 0 })).cost, 0);
    assert.equal(estimateCost([step(zero)], catalog({})).cost, 0);
    assert.equal(estimateCost([step(zero)], catalog(undefined)).cost, 0);
    assert.equal(estimateCost([step({ ...zero, reasoning: 10 })], catalog({})).unpricedByReason['missing-rate'], 1);
    assert.equal(estimateCost([step(zero)], catalog({ input: -1 })).status, 'unavailable');
    assert.equal(estimateCost([step({ ...zero, output: 10 })], catalog({ output: 4 })).cost, 0.00004);
    const missing = estimateCost([step()], catalog({ input: 2, output: 8, cache_read: 0.5 }));
    assert.equal(missing.status, 'unavailable');
    assert.equal(missing.unpricedByReason['missing-rate'], 1);
  });

  it('estimates free variants at paid base rates, overriding explicit free variant rates', () => {
    for (const pricing of [catalog(rates), modelCatalog({ model: rates, 'model-free': { input: 0, output: 0, cache_read: 0, cache_write: 0 } })]) {
      const original = step({ model: 'model-free', cost: 0 });
      const result = estimateCost([original], pricing);
      assert.equal(result.status, 'complete');
      assert.equal(result.cost, .00365);
      assert.equal(original.model, 'model-free');
      assert.equal(original.cost, 0);
    }
    assert.equal(estimateCost([step({ model: 'model-free' })], modelCatalog({ 'model-free': rates })).unpricedByReason['no-model-price'], 1);
  });

  it('uses published model-specific Fast and Ultrafast multipliers on all token categories', () => {
    for (const [model, multiplier] of [
      ['gpt-6.1-sol-fast', 2], ['gpt-6-astra-fast', 2],
      ['gpt-6.1-sol-ultrafast', 6], ['gpt-6-astra-ultrafast', 6],
      ['gpt-5.5-fast', 2.5], ['gpt-5-mini-fast', 1.8],
      ['gpt-4.1-fast', 1.75], ['gpt-4o-fast', 1.7],
      ['gpt-4o-mini-fast', 5 / 3], ['o4-mini-fast', 20 / 11],
      ['gpt-6.1-sol-fast-free', 2],
    ] as const) {
      const baseId = model.replace(/-free$/, '').replace(/-(ultrafast|fast)$/, '');
      const result = estimateCost([step({ model })], modelCatalog({ [baseId]: rates }));
      assert.equal(result.status, 'complete', model);
      assert.equal(result.cost, .00365 * multiplier, model);
    }
  });

  it('applies variant multipliers after selecting the context tier', () => {
    const pricing = modelCatalog({ 'gpt-6.1-sol': { input: 1, tiers: [
      { tier: { type: 'context', size: 1000 }, input: 2 },
    ] } });
    for (const [suffix, multiplier] of [['free', 1], ['fast', 2], ['ultrafast', 6]] as const) {
      assert.equal(estimateCost([step({ ...zero, input: 1000, model: `gpt-6.1-sol-${suffix}` })], pricing).cost, .001 * multiplier);
      assert.equal(estimateCost([step({ ...zero, input: 1001, model: `gpt-6.1-sol-${suffix}` })], pricing).cost, .002002 * multiplier);
    }
  });

  it('does not invent variant prices or bypass provider, identity, or token validation', () => {
    const pricing = modelCatalog({ 'gpt-6.1-sol': rates, model: rates });
    for (const model of ['model-fast', 'model-ultrafast', 'gpt-5-ultrafast', 'gpt-6.1-sol-free-other']) {
      assert.equal(estimateCost([step({ model })], pricing).unpricedByReason['no-model-price'], 1);
    }
    assert.equal(estimateCost([step({ provider: 'other', model: 'gpt-6.1-sol-fast' })], pricing).unpricedByReason['no-model-price'], 1);
    assert.equal(estimateCost([step({ model: 'gpt-6.1-sol-free', input: null })], pricing).unpricedByReason['missing-tokens'], 1);
    assert.equal(estimateCost([step({ model: 'model-free' })], modelCatalog({ model: { input: 2 } })).unpricedByReason['missing-rate'], 1);
    const conflicting = catalog(rates);
    const provider = conflicting.providers!['provider'] as { models: { model: { id: string } } };
    provider.models.model.id = 'model-free';
    assert.equal(estimateCost([step({ model: 'model-free' })], conflicting).unpricedByReason['no-model-price'], 1);
  });

  it('searches both OpenCode providers for base models in either direction', () => {
    for (const [source, target] of [['opencode', 'opencode-go'], ['opencode-go', 'opencode']] as const) {
      for (const sourcePresent of [false, true]) {
        const pricing = parseCatalog(JSON.stringify({ updatedAt: 0, body: JSON.stringify({
          ...(sourcePresent ? { [source]: { id: source, models: {} } } : {}),
          [target]: { id: target, models: {
            'muse-spark-1.3-contributor': { id: 'muse-spark-1.3-contributor', cost: { input: .1, output: .2, cache_read: .002 } },
            'gpt-6.1-sol': { id: 'gpt-6.1-sol', cost: rates },
          } },
        }) }));
        for (const model of ['muse-spark-1.3-contributor', 'muse-spark-1.3-contributor-free']) {
          const original = step({ ...zero, provider: source, model, input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cost: 0 });
          const result = estimateCost([original], pricing);
          assert.equal(result.status, 'complete');
          assert.equal(result.cost, .302);
          assert.equal(original.provider, source);
          assert.equal(original.model, model);
          assert.equal(original.cost, 0);
        }
        assert.equal(estimateCost([step({ provider: source, model: 'gpt-6.1-sol-fast' })], pricing).cost, .00365 * 2);
        assert.equal(estimateCost([step({ provider: 'other', model: 'muse-spark-1.3-contributor-free' })], pricing).unpricedByReason['no-model-price'], 1);
      }
    }
  });

  it('prefers the original OpenCode provider and does not hide invalid identities or rates', () => {
    for (const source of ['opencode', 'opencode-go']) {
      const target = source === 'opencode' ? 'opencode-go' : 'opencode';
      for (const [entry, expected] of [
        [{ id: source, models: { model: { id: 'model', cost: rates } } }, .00365],
        [{ id: source, models: { model: { id: 'model', cost: { input: -1 } } } }, null],
        [{ id: 'wrong', models: {} }, null],
        [{ id: source, models: { model: { id: 'wrong', cost: rates } } }, null],
      ] as const) {
        const pricing = parseCatalog(JSON.stringify({ updatedAt: 0, body: JSON.stringify({
          [source]: entry,
          [target]: { id: target, models: { model: { id: 'model', cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 } } } },
        }) }));
        assert.equal(estimateCost([step({ provider: source, model: 'model-free' })], pricing).cost, expected);
      }
    }
  });

  it('uses strict full-context tier boundaries including cache writes and the highest tier', () => {
    const pricing = catalog({ input: 1, tiers: [
      { tier: { type: 'context', size: 1000 }, input: 2, cache_read: 2, cache_write: 2 },
      { tier: { type: 'context', size: 2000 }, input: 4, cache_read: 4, cache_write: 4 },
    ] });
    assert.equal(estimateCost([step({ ...zero, input: 1000 })], pricing).cost, .001);
    assert.equal(estimateCost([step({ ...zero, input: 1001 })], pricing).cost, .002002);
    assert.equal(estimateCost([step({ ...zero, input: 2000 })], pricing).cost, .004);
    assert.equal(estimateCost([step({ ...zero, input: 2001 })], pricing).cost, .008004);
    assert.equal(estimateCost([step({ ...zero, input: 500, cacheRead: 300, cacheWrite: 201 })], pricing).cost, .002002);
  });

  it('ignores legacy context_over_200k instead of inventing prices', () => {
    const pricing = catalog({ input: 1, context_over_200k: { input: 99 } });
    assert.equal(estimateCost([step({ ...zero, input: 300_000 })], pricing).cost, .3);
  });

  it('never aliases a provider or a conflicting catalog identity', () => {
    const pricing = catalog(rates);
    for (const overrides of [{ provider: 'other' }, { provider: null }, { model: null }, { model: 'other' }]) {
      assert.equal(estimateCost([step(overrides)], pricing).unpricedByReason['no-model-price'], 1);
    }
    const conflicting = parseCatalog(JSON.stringify({ updatedAt: 0, body: JSON.stringify({ provider: { id: 'other', models: { model: { id: 'model', cost: rates } } } }) }));
    assert.equal(estimateCost([step()], conflicting).status, 'unavailable');
  });

  it('reports partial subtotal, unpriced steps/models and missing-token coverage without modifying cost', () => {
    const result = estimateCost([step(), step({ model: 'unknown' }), step({ input: null }), step({ reasoning: -1 })], catalog(rates));
    assert.equal(result.status, 'partial');
    assert.equal(result.cost, .00365);
    assert.equal(result.pricedSteps, 1);
    assert.equal(result.unpricedSteps, 3);
    assert.equal(result.unpricedByReason['missing-tokens'], 2);
    assert.deepEqual(result.unpricedModels, [{ provider: 'provider', model: 'model', steps: 2 }, { provider: 'provider', model: 'unknown', steps: 1 }]);
  });

  it('bounds unpriced identity metadata', () => {
    const result = estimateCost(Array.from({ length: 70 }, (_, i) => step({ model: `unknown-${i}` })), catalog(rates));
    assert.equal(result.unpricedModels.length, 50);
    assert.equal(result.unpricedModelsTruncated, true);
  });

  it('missing or malformed optional catalogs disable only estimates', () => {
    for (const raw of [null, '', '{', '[]', '{}', JSON.stringify({ updatedAt: 0, body: {} }), JSON.stringify({ updatedAt: 'bad', body: '{}' }), JSON.stringify({ updatedAt: 0, body: '[]' }), JSON.stringify({ updatedAt: 0, body: '{' })]) {
      const pricing = parseCatalog(raw);
      assert.equal(pricing.meta.available, false);
      assert.equal(estimateCost([step()], pricing).cost, null);
    }
  });

  it('rejects negative, nonfinite, null and nonnumeric applicable rates', () => {
    for (const input of [-1, null, '2', true]) {
      assert.equal(estimateCost([step()], catalog({ ...rates, input })).status, 'unavailable');
    }
    // JSON syntax permits exponents that overflow JS numbers.
    const raw = JSON.stringify({ updatedAt: 0, body: '{"provider":{"id":"provider","models":{"model":{"id":"model","cost":{"input":1e999}}}}}' });
    assert.equal(estimateCost([step({ ...zero, input: 1 })], parseCatalog(raw)).status, 'unavailable');
  });

  it('rejects ambiguous/invalid applicable tiers and does not inherit missing tier rates', () => {
    const first = { tier: { type: 'context', size: 10 }, ...rates };
    for (const tiers of [[first, first], [{ ...first, tier: { type: 'context', size: -1 } }], [{ ...first, input: -1 }], [{ tier: { type: 'context', size: 10 } }], {}, [null]]) {
      assert.equal(estimateCost([step()], catalog({ ...rates, tiers })).status, 'unavailable');
    }
    assert.equal(estimateCost([step({ ...zero, input: 10 })], catalog({ input: 1, tiers: [first, first] })).cost, .00001);
    assert.equal(estimateCost([step()], catalog({ ...rates, tiers: [{ ...first, input: -1 }, { ...first, tier: { type: 'context', size: 20 } }] })).status, 'unavailable');
  });
});

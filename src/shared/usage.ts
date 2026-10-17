import type { TokenTotals } from './api.ts';

/** Sum measured categories without turning an entirely unmeasured value into zero. */
export function measuredTokenSum(tokens: TokenTotals): number | null {
  const values = [tokens.input, tokens.output, tokens.reasoning, tokens.cacheRead, tokens.cacheWrite]
    .map((category) => category.value)
    .filter((value): value is number => value !== null);
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0);
}

/** Rank a measured subtotal by its numeric value, without claiming complete coverage. */
export function tokenSortValue(tokens: TokenTotals): number | null {
  return tokens.total ?? measuredTokenSum(tokens);
}

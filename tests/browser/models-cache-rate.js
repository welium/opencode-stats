// Use create-review-fixture.ts's synthetic database and the production server.
// playwright-cli -s=cache-rate run-code --filename=tests/browser/models-cache-rate.js
async (page) => {
  const origin = new URL(page.url()).origin;
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const response = await page.request.get(`${origin}/api/stats/models?range=7d`);
  const payload = await response.json();
  check(payload.models.find((row) => row.model === 'second').usage.cacheRate === null, 'Canonical API cache rate remains unavailable');
  await page.goto(`${origin}/#/models?range=7d`);
  const table = page.getByRole('table', { name: 'Usage per provider and model', exact: true });
  const second = table.locator('tbody tr').filter({ has: page.getByText('second', { exact: true }) });
  const estimated = second.locator('td').nth(3);
  await estimated.waitFor();
  check(await estimated.innerText() === '0.0%*', 'Incomplete cache rate displayed with asterisk');
  check(await estimated.locator('.partial-mark').count() === 1, 'Same asterisk representation');
  check(await estimated.locator('[title="Estimated from incomplete token data"]').count() === 1, 'Estimate has a concise hint');
  const priced = table.locator('tbody tr').filter({ has: page.getByText('priced', { exact: true }) });
  check(await priced.locator('td').nth(3).innerText() === '27.3%', 'Complete rate stays exact without marker');
  const sort = table.getByRole('button', { name: /^Cache rate/ });
  await sort.click();
  check((await table.locator('tbody tr').first().innerText()).includes('priced'), 'Descending uses displayed rate');
  await sort.click();
  check((await table.locator('tbody tr').first().innerText()).includes('second'), 'Ascending ranks incomplete rate numerically');
  await page.screenshot({ path: '/tmp/opencode/chart-hover/models-cache-rate.png' });
  return { estimatedRateWithAsterisk: true, sorting: true, canonicalApiUnchanged: true };
}

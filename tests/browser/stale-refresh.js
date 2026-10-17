// Run against a built dashboard with a compatible synthetic database:
// playwright-cli -s=refresh run-code --filename=tests/browser/stale-refresh.js
// The first Overview fetch deliberately ignores AbortSignal and completes last.
async (page) => {
  const origin = new URL(page.url()).origin;
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    let held = false;
    window.fetch = async (input, options) => {
      if (!held && String(input).startsWith('/api/stats/overview')) {
        held = true;
        const response = await original(input, { ...options, signal: undefined });
        const payload = await response.json();
        payload.usage.cost.value = 987654321;
        return new Promise((resolve) => {
          window.releaseOldOverview = () => {
            resolve(new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } }));
          };
        });
      }
      return original(input, options);
    };
  });
  await page.goto(`${origin}/#/overview?range=all`);
  await page.reload();
  await page.waitForFunction(() => typeof window.releaseOldOverview === 'function');
  await page.getByRole('button', { name: 'Refresh statistics' }).click();
  await page.locator('.stat-value').first().waitFor();
  await page.getByRole('button', { name: 'Refresh statistics' }).waitFor({ state: 'visible' });
  await page.waitForFunction(() => !document.querySelector('[aria-label="Refresh statistics"]').disabled);
  const current = await page.locator('.stat-grid').first().innerText();
  await page.evaluate(async () => {
    window.releaseOldOverview();
    // Cross a paint boundary after the old promise and React updates settle.
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  const after = await page.locator('.stat-grid').first().innerText();
  if (after !== current) throw new Error(`Stale response overwrote refreshed values: ${after}`);
  return { staleResponseIgnored: true, current };
}

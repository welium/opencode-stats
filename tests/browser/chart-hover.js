// Production regression with create-review-fixture.ts's synthetic DB:
// playwright-cli -s=chart-hover run-code --filename=tests/browser/chart-hover.js
async (page) => {
  const origin = new URL(page.url()).origin;
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => {
    if (['error', 'warning'].includes(message.type())) errors.push(message.text());
  });
  page.on('request', (request) => {
    if (new URL(request.url()).origin !== origin) errors.push(`External request: ${request.url()}`);
  });
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${origin}/#/overview?range=7d`);
  await page.reload();
  const chart = page.getByRole('slider').first();
  await chart.waitFor();
  check(await page.getByRole('radio', { name: 'Tokens', exact: true }).isChecked(), 'Tokens must be the default metric');
  const tooltip = page.getByRole('tooltip');
  const row = (label) => tooltip.locator('dl > div').filter({ has: page.getByText(label, { exact: true }) }).locator('dd');
  const data = await (await page.request.get(`${origin}/api/stats/overview?range=7d`)).json();
  const dates = data.daily.map((point) => point.date);
  const hoverDay = async (index) => {
    await chart.scrollIntoViewIfNeeded();
    const box = await chart.boundingBox();
    check(box !== null, 'Chart has bounds');
    await page.mouse.move(box.x + box.width * (index + 0.5) / dates.length, box.y + 70);
    await tooltip.getByText(dates[index], { exact: true }).waitFor();
  };

  // The full day-wide hit area works even when the token bar is absent.
  await hoverDay(dates.length - 1);
  check(await row('Tokens').innerText() === '—', 'Incomplete tokens must remain unavailable');
  check(await row('Recorded cost').innerText() === '—', 'Incomplete cost must remain unavailable');
  check((await row('API-equivalent estimate').innerText()).includes('Partial subtotal'), 'Partial estimate must be labeled');
  check(await row('Steps').innerText() === '2', 'Daily steps shown');
  await page.screenshot({ path: '/tmp/opencode/chart-hover/partial-tooltip.png' });
  await page.mouse.move(0, 0);
  check(await tooltip.count() === 0, 'Pointer exit dismisses tooltip');

  // Single tab stop, arrow/Home/End navigation and Escape dismissal.
  await chart.focus();
  await page.keyboard.press('End');
  check((await chart.getAttribute('aria-valuetext')).includes('partial subtotal'), 'Accessible value labels partial coverage');
  await page.keyboard.press('ArrowLeft');
  check(await row('Tokens').innerText() === '100', 'Keyboard selects preceding date');
  check(await row('Recorded cost').innerText() === '$3.00', 'Recorded cost stays separate');
  check(await row('API-equivalent estimate').innerText() === '$0.0002', 'Complete estimate shown');
  await page.keyboard.press('Home');
  check(await row('Tokens').innerText() === '0', 'Measured zero is not unavailable');
  check(await row('Recorded cost').innerText() === '$0.00', 'Zero recorded cost shown');
  await page.keyboard.press('Escape');
  check(await tooltip.count() === 0, 'Escape dismisses tooltip');
  await page.getByRole('radio', { name: 'Cost', exact: true }).check();
  await hoverDay(dates.length - 2);
  check(await row('Tokens').innerText() === '100', 'All details remain available after metric switch');

  // A missing catalog must never turn an estimate into $0.
  await page.route('**/api/stats/overview?*', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    for (const point of body.dailyEstimates) point.estimate = { ...point.estimate, status: 'unavailable', cost: null };
    await route.fulfill({ response, json: body });
  });
  await page.getByRole('button', { name: 'Refresh statistics' }).click();
  await page.waitForFunction(() => !document.querySelector('[aria-label="Refresh statistics"]').disabled);
  await hoverDay(dates.length - 1);
  check(await row('API-equivalent estimate').innerText() === '—', 'Unavailable estimate shown as dash');
  await page.unroute('**/api/stats/overview?*');

  // Tooltips stay within the plot at either edge, including 320px screens.
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const theme of ['light', 'dark']) {
      await page.evaluate((value) => document.documentElement.dataset.theme = value, theme);
      for (const index of [0, dates.length - 1]) {
        await hoverDay(index);
        const bounds = await tooltip.boundingBox();
        check(bounds.x >= 0 && bounds.x + bounds.width <= width, `Tooltip contained at ${width}px in ${theme}`);
        check(await page.evaluate(() => document.documentElement.scrollWidth === document.documentElement.clientWidth), 'No page overflow');
      }
    }
  }
  await page.setViewportSize({ width: 320, height: 1000 });
  await hoverDay(dates.length - 1);
  await page.screenshot({ path: '/tmp/opencode/chart-hover/mobile-tooltip.png' });
  await chart.dispatchEvent('pointerdown', { pointerType: 'touch', clientX: (await chart.boundingBox()).x + 1 });
  await chart.dispatchEvent('pointerleave', { pointerType: 'touch' });
  check(await tooltip.count() === 1, 'Touch details persist after lifting finger');

  await page.goto(`${origin}/#/sessions/s?range=7d`);
  await page.getByRole('slider', { name: 'Daily tokens, daily details' }).waitFor();
  check(errors.length === 0, errors.join('\n'));
  return { defaultTokens: true, hover: true, keyboard: true, touch: true, unavailableAndPartial: true, responsive: true, errors };
}

// Run against the production server with create-review-fixture.ts's synthetic DB:
// playwright-cli -s=repair1 run-code --filename=tests/browser/review-repair.js
async (page) => {
  const origin = new URL(page.url()).origin;
  const requests = [];
  const errors = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin !== origin) throw new Error(`External request: ${url}`);
    if (url.pathname.startsWith('/api/stats/')) requests.push(url.pathname + url.search);
  });
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => { if (['error', 'warning'].includes(message.type())) errors.push(message.text()); });
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const settled = async () => {
    await page.locator('.stat-grid').first().waitFor();
    await page.waitForFunction(() => !document.querySelector('[aria-label="Refresh statistics"]').disabled);
  };
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${origin}/#/projects?range=all`);
  await page.reload();
  await settled();
  await page.getByRole('link', { name: 'Synthetic project', exact: true }).click();
  await page.getByRole('heading', { name: 'Sessions', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Clear Project filter' }).waitFor();

  const verifyRequests = async (action, expectedProject, paths) => {
    const start = requests.length;
    const responses = paths.map((path) => page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === `/api/stats/${path}` && url.searchParams.get('projectId') === expectedProject;
    }));
    await action();
    await Promise.all(responses);
    await settled();
    const batch = requests.slice(start);
    for (const path of paths) {
      const match = batch.filter((request) => new URL(request, origin).pathname === `/api/stats/${path}`);
      check(match.length > 0, `Missing ${path} request: ${batch}`);
      for (const request of match) check(new URL(request, origin).searchParams.get('projectId') === expectedProject, `Wrong project: ${request}`);
    }
    if (expectedProject === null) check(await page.getByRole('button', { name: 'Clear Project filter' }).count() === 0, 'Cleared filter still visible');
    else await page.getByRole('button', { name: 'Clear Project filter' }).waitFor();
    return batch;
  };
  const network = [];
  network.push(await verifyRequests(() => page.getByRole('link', { name: 'Overview', exact: true }).click(), 'p', ['overview', 'models', 'projects']));
  network.push(await verifyRequests(() => page.getByRole('link', { name: 'Models', exact: true }).click(), 'p', ['models']));
  network.push(await verifyRequests(() => page.getByRole('button', { name: 'Clear Project filter' }).click(), null, ['models']));
  network.push(await verifyRequests(() => page.goBack(), 'p', ['models']));
  network.push(await verifyRequests(() => page.goForward(), null, ['models']));
  // Same page and range, different project: query identity must change too.
  network.push(await verifyRequests(() => page.evaluate(() => { location.hash = '#/models?range=all&projectId=q'; }), 'q', ['models']));
  network.push(await verifyRequests(() => page.getByRole('link', { name: 'Overview', exact: true }).click(), 'q', ['overview', 'models', 'projects']));
  network.push(await verifyRequests(() => page.evaluate(() => { location.hash = '#/overview?range=all&projectId=p'; }), 'p', ['overview', 'models', 'projects']));
  // A complete 1250-token/$7 step + input-only 100 must be unavailable,
  // including the chart summary and expanded data table, for that local date.
  for (const metric of ['Tokens', 'Cost']) {
    await page.getByRole('radio', { name: metric, exact: true }).check();
    const chart = page.locator('figure.chart').first();
    check((await chart.locator('.chart-caption').innerText()).includes('No measured values'), `Partial ${metric} became a total`);
    await chart.locator('summary').click();
    const rows = await chart.locator('tbody tr').allTextContents();
    check(rows.some((row) => row.includes('—')), `Partial ${metric} is not unavailable in data table`);
    check(!(await chart.locator('[role="img"]').getAttribute('aria-label')).includes('total 1.35'), 'Partial token summary');
    await chart.screenshot({ path: `/tmp/opencode/repair1/daily-incomplete-${metric.toLowerCase()}.png` });
    await chart.locator('summary').click();
  }
  await page.getByRole('button', { name: 'Clear Project filter' }).click();
  await settled();
  for (const [metric, subtotal] of [['Tokens', '100'], ['Cost', '$3.00']]) {
    await page.getByRole('radio', { name: metric, exact: true }).check();
    const chart = page.locator('figure.chart').first();
    check((await chart.locator('.chart-caption').innerText()).includes(`Measured subtotal ${subtotal}`), `Cross-day ${metric} mislabeled`);
    check((await chart.locator('[role="img"]').getAttribute('aria-label')).includes('measured subtotal'), 'Accessible summary mislabeled');
  }
  const layout = [];
  for (const theme of ['light', 'dark']) {
    if (await page.evaluate(() => document.documentElement.dataset.theme) !== theme) {
      await page.getByRole('button', { name: `Switch to ${theme} theme` }).click();
    }
    for (const width of [320, 390, 1440]) {
      await page.setViewportSize({ width, height: 844 });
      await page.getByRole('radio', { name: 'Tokens', exact: true }).check();
      const dimensions = await page.evaluate(() => ({
        width: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        tables: [...document.querySelectorAll('.table-scroll')].map((element) => ({ width: element.clientWidth, scrollWidth: element.scrollWidth })),
      }));
      check(dimensions.scrollWidth <= dimensions.width, `${theme}/${width}: page overflow ${JSON.stringify(dimensions)}`);
      if (width < 620) {
        check(dimensions.tables.some((table) => table.scrollWidth > table.width), 'Wide tables must scroll internally');
        const scroll = page.locator('.table-scroll').last();
        check(await scroll.evaluate((element) => { element.scrollLeft = 100; return element.scrollLeft > 0; }), 'Table cannot scroll');
        await scroll.evaluate((element) => { element.scrollLeft = 0; });
      }
      await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
      await page.screenshot({ path: `/tmp/opencode/repair1/overview-${width}-${theme}.png`, fullPage: true, animations: 'disabled' });
      layout.push({ theme, ...dimensions });
    }
  }
  await page.setViewportSize({ width: 320, height: 844 });
  const menu = page.getByRole('button', { name: 'Open navigation' });
  await menu.click();
  await page.getByRole('link', { name: 'Models', exact: true }).focus();
  await page.keyboard.press('Escape');
  check(await menu.evaluate((element) => document.activeElement === element), 'Drawer focus did not return');
  check(errors.length === 0, `Browser errors: ${errors}`);
  return { dailyIncompleteRendering: true, projectNavigationAndHistory: true, network, layout, errors };
}

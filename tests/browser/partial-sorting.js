// Use create-review-fixture.ts's synthetic database with the production server.
// playwright-cli -s=sorting run-code --filename=tests/browser/partial-sorting.js
async (page) => {
  const origin = new URL(page.url()).origin;
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const verify = async (table, direction) => {
    const headings = await table.locator('thead th').allTextContents();
    const tokenColumn = headings.findIndex((text) => text.trim() === 'Tokens');
    check(tokenColumn >= 0, 'Token column exists');
    const cells = table.locator(`tbody tr td:nth-child(${tokenColumn + 1})`);
    const texts = await cells.allTextContents();
    check(texts.length > 1, 'Fixture must include multiple ranked rows');
    check(texts.some((text) => text.includes('*')), 'Fixture must include a partial subtotal');
    check(texts.every((text) => !text.includes('≥')), 'No ≥ prefix; asterisk retained');
    const values = texts.map((text) => {
      const clean = text.replace(/\*/g, '').replace(/,/g, '').trim();
      if (clean === '—') return null;
      const match = /^(\d+(?:\.\d+)?)([kMB])?$/.exec(clean);
      check(match !== null, `Numeric token value: ${clean}`);
      return Number(match[1]) * ({ k: 1e3, M: 1e6, B: 1e9 }[match[2]] ?? 1);
    });
    for (let i = 1; i < values.length; i++) {
      if (values[i] === null) continue;
      check(values[i - 1] !== null, 'Unavailable values sorted last');
      check(direction === 'desc' ? values[i - 1] >= values[i] : values[i - 1] <= values[i], `Partial numeric order (${direction}): ${texts.join(', ')}`);
    }
  };
  const routes = [
    ['overview', ['Usage by agent', 'Top models by usage', 'Top projects by usage']],
    ['models', ['Usage per provider and model']],
    ['projects', ['Usage per project']],
    ['sessions', ['Sessions with activity in the selected range']],
  ];
  for (const [route, captions] of routes) {
    await page.goto(`${origin}/#/${route}?range=all&sort=tokens&dir=desc`);
    for (const caption of captions) {
      const table = page.getByRole('table', { name: caption, exact: true });
      await table.waitFor();
      await verify(table, 'desc');
      await table.getByRole('button', { name: /^Tokens/ }).click();
      await page.waitForFunction(() => !document.querySelector('[aria-label="Refresh statistics"]').disabled);
      await verify(table, 'asc');
    }
  }
  return { overviewModelsProjectsSessions: true, numericPartialSortingBothDirections: true, asteriskOnly: true };
}

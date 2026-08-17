import { expect, test } from '@playwright/test';

/** Wait for the app to finish loading its bundled map/team data. */
async function ready(page: import('@playwright/test').Page): Promise<void> {
  await expect(page.locator('svg.board-main')).toBeVisible();
}

/** The tab bar only exists below the desktop breakpoint; on desktop every pane is on screen. */
async function openTab(page: import('@playwright/test').Page, label: RegExp): Promise<void> {
  const tab = page.getByRole('tab', { name: label });
  if (await tab.count()) await tab.first().click();
}

test('app loads, renders the board, and never scrolls horizontally', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Kill Team', level: 1 })).toBeVisible();
  await expect(page.locator('svg.board-main')).toHaveCount(1);
  await expect(page.locator('svg.board-main')).toBeVisible();

  // Nothing may hang off the left/right edge — the phone failure mode of the previous app.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);

  expect(errors).toEqual([]);
});

test('the roll-off starts a battle and the log records the dice', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  await openTab(page, /Play/);
  await page.getByRole('button', { name: /Roll off/ }).click();
  await openTab(page, /Log/);
  await expect(page.getByText(/Initiative roll-off/)).toBeVisible();
});

test('tapping two operatives opens the targeting-line inspector', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  // No operatives are on the board before deployment, so the inspector must stay closed.
  await expect(page.getByRole('heading', { name: /Targeting line/ })).toHaveCount(0);
});

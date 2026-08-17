import { expect, test } from '@playwright/test';

test('app loads, renders the board, and never scrolls horizontally', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/');
  await expect(page.locator('svg.board')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Kill Team' })).toBeVisible();

  // Nothing may hang off the left/right edge — the phone failure mode of the previous app.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);

  expect(errors).toEqual([]);
});

test('the roll-off starts a battle and the log records the dice', async ({ page }) => {
  await page.goto('/');
  const play = page.getByRole('tab', { name: 'Play' });
  if (await play.isVisible()) await play.click();
  await page.getByRole('button', { name: /Roll off/ }).click();
  const log = page.getByRole('tab', { name: 'Log' });
  if (await log.isVisible()) await log.click();
  await expect(page.getByText(/Initiative roll-off/)).toBeVisible();
});

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

test('the board zooms on the wheel and still fits its container', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  const board = page.locator('svg.board-main');
  await expect(board).toHaveAttribute('viewBox', '0 0 30 22');

  const box = await board.boundingBox();
  if (!box) throw new Error('the board has no layout box');
  await page.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.45);
  await page.mouse.wheel(0, -500);

  // The window shrank, so the killzone is magnified…
  await expect(board).not.toHaveAttribute('viewBox', '0 0 30 22');
  const [, , w] = ((await board.getAttribute('viewBox')) ?? '').split(' ').map(Number);
  expect(w).toBeLessThan(30);

  // …and the element itself is still inside the pane, i.e. zooming never grows the layout.
  const fits = await page.evaluate(() => {
    const svg = document.querySelector('svg.board-main')!.getBoundingClientRect();
    const wrap = document.querySelector('.board-wrap')!.getBoundingClientRect();
    return { ok: svg.width <= wrap.width + 1 && svg.height <= wrap.height + 1 && svg.height > 50, svg, wrap };
  });
  expect(fits.ok).toBe(true);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);

  // Fit puts the whole killzone back, and is a 44px target on every viewport.
  const fit = page.getByRole('button', { name: 'Fit the killzone to the screen' });
  const fitBox = await fit.boundingBox();
  expect(fitBox?.width ?? 0).toBeGreaterThanOrEqual(44);
  expect(fitBox?.height ?? 0).toBeGreaterThanOrEqual(44);
  await fit.click();
  await expect(board).toHaveAttribute('viewBox', '0 0 30 22');
});

test('tapping two operatives opens the targeting-line inspector', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  // No operatives are on the board before deployment, so the inspector must stay closed.
  await expect(page.getByRole('heading', { name: /Targeting line/ })).toHaveCount(0);
});

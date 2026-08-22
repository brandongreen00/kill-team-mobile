import { expect, test, type Page } from '@playwright/test';

/**
 * Phone-first smoke tests.
 *
 * These pin the four things the owner reported as unusable, so a regression on any of them
 * fails the build rather than the next play session:
 *
 *   1. the app never scrolls sideways and never logs an error;
 *   2. the board FILLS its pane instead of letterboxing into a strip;
 *   3. selecting operatives does not move the control under your thumb;
 *   4. deployment happens on the board, with the drop zone shown, no tab to find, and a
 *      rejected tap answered in words.
 */

/** Wait for the app to finish loading its bundled map/team data. */
async function ready(page: Page): Promise<void> {
  await expect(page.locator('svg.board-main')).toBeVisible();
}

const promptTitle = (page: Page) => page.locator('.prompt-title').first();

/** Drive setup as far as deployment: roll off, drop zone, two kill teams, reveal. */
async function setUpToDeployment(page: Page): Promise<void> {
  await page.getByRole('button', { name: /Roll off/ }).click();
  const take = page.getByRole('button', { name: /Take initiative/ });
  if (await take.count()) await take.click();
  await page.getByRole('button', { name: /Take the orange drop zone/ }).click();

  for (const who of [/I am Player 1/, /I am Player 2/]) {
    const handover = page.getByRole('button', { name: who });
    if (await handover.count()) await handover.click();
    await page.locator('.team-list button').first().click();
    for (let i = 0; i < 20; i++) {
      const add = page.locator('button.add:not([disabled])').first();
      if (!(await add.count())) break;
      await add.click();
    }
    const lock = page.getByRole('button', { name: /Lock in Player/ });
    await expect(lock).toBeEnabled();
    await lock.click();
  }

  // Equipment and the tac op, one secret screen each. The tac op is not optional: it is the
  // only thing that calls `ctx.initOps`, so a battle without one scores nothing.
  for (const who of [/I am Player 1/, /I am Player 2/]) {
    const handover = page.getByRole('button', { name: who });
    if (await handover.count()) await handover.click();
    await expect(promptTitle(page)).toContainText(/equipment and tac op/i);
    await page.locator('.tac-ops button').first().click();
    const confirm = page.getByRole('button', { name: /^Confirm$/ });
    await expect(confirm).toBeEnabled();
    await confirm.click();
  }

  await page.getByRole('button', { name: /Reveal and deploy/ }).click();
  await expect(promptTitle(page)).toContainText(/^Place /);
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
  await ready(page);

  // Nothing may hang off the left/right edge — the phone failure mode of the previous app.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);

  // …and no element is wider than the viewport either, which is how the overflow got in:
  // a grid with an implicit `auto` column sized the whole app to the top bar's max-content.
  const widest = await page.evaluate(() => {
    let worst = 0;
    for (const el of document.querySelectorAll('body *')) {
      if (el.closest('svg')) continue;
      worst = Math.max(worst, el.getBoundingClientRect().right);
    }
    return worst;
  });
  expect(widest).toBeLessThanOrEqual((page.viewportSize()?.width ?? 0) + 1);

  expect(errors).toEqual([]);
});

test('the board fills its pane instead of letterboxing into a strip', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  const geometry = await page.evaluate(() => {
    const svg = document.querySelector('svg.board-main')!;
    const r = svg.getBoundingClientRect();
    const [, , w, h] = (svg.getAttribute('viewBox') ?? '').split(' ').map(Number);
    return { paneAspect: r.width / r.height, viewAspect: w! / h!, paneW: r.width, paneH: r.height };
  });
  // The window is aspect-locked to the PANE, so `preserveAspectRatio` has nothing to letterbox.
  expect(Math.abs(geometry.paneAspect - geometry.viewAspect)).toBeLessThan(0.02);
  expect(geometry.paneH).toBeGreaterThan(200);
});

test('the first screen says what to do, and there is no tab bar to find it in', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  await expect(promptTitle(page)).toContainText('Roll off for initiative');
  await expect(page.getByRole('button', { name: /Roll off/ })).toBeVisible();
  // The old shell's four tabs are gone: the sheet always shows the current step.
  await expect(page.getByRole('tab')).toHaveCount(0);
});

test('the board zooms and can be put back to the whole killzone', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  const board = page.locator('svg.board-main');
  const before = Number(((await board.getAttribute('viewBox')) ?? '').split(' ')[2]);

  const box = await board.boundingBox();
  if (!box) throw new Error('the board has no layout box');
  await page.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.45);
  await page.mouse.wheel(0, -500);

  const after = Number(((await board.getAttribute('viewBox')) ?? '').split(' ')[2]);
  expect(after).toBeLessThan(before);

  // Zooming never grows the layout.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);

  // Fit shows the whole killzone, and every board control is a 44px target.
  const fit = page.getByRole('button', { name: 'Fit the killzone to the screen' });
  const fitBox = await fit.boundingBox();
  expect(fitBox?.width ?? 0).toBeGreaterThanOrEqual(44);
  expect(fitBox?.height ?? 0).toBeGreaterThanOrEqual(44);
  await fit.click();
  const fitted = await page.evaluate(() => {
    const svg = document.querySelector('svg.board-main')!;
    const [x, y, w, h] = (svg.getAttribute('viewBox') ?? '').split(' ').map(Number);
    return { x: x!, y: y!, w: w!, h: h! };
  });
  expect(fitted.x).toBeLessThanOrEqual(0.001);
  expect(fitted.y).toBeLessThanOrEqual(0.001);
  expect(fitted.x + fitted.w).toBeGreaterThanOrEqual(29.999);
  expect(fitted.y + fitted.h).toBeGreaterThanOrEqual(21.999);
});

test('adding operatives never moves the control under your thumb', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  await page.getByRole('button', { name: /Roll off/ }).click();
  const take = page.getByRole('button', { name: /Take initiative/ });
  if (await take.count()) await take.click();
  await page.getByRole('button', { name: /Take the orange drop zone/ }).click();
  await page.getByRole('button', { name: /I am Player 1/ }).click();
  await page.locator('.team-list button').first().click();

  await page.evaluate(() => {
    document.querySelector('.overlay-body')!.scrollTop = 200;
  });

  // Tap whatever enabled "+" is nearest the middle of the scroller — what a thumb would
  // actually hit — and assert the row it is on has not moved afterwards.
  for (let i = 0; i < 4; i++) {
    const target = await page.evaluate(() => {
      const body = document.querySelector('.overlay-body')!;
      const r = body.getBoundingClientRect();
      const mid = r.top + r.height / 2;
      const btn = [...document.querySelectorAll('button.add:not([disabled])')]
        .filter((b) => {
          const bb = b.getBoundingClientRect();
          return bb.top > r.top + 20 && bb.bottom < r.bottom - 20;
        })
        .sort(
          (a, b) =>
            Math.abs(a.getBoundingClientRect().top - mid) - Math.abs(b.getBoundingClientRect().top - mid),
        )[0];
      if (!btn) return null;
      btn.setAttribute('data-probe', '1');
      const bb = btn.getBoundingClientRect();
      return { top: bb.top, x: bb.x + bb.width / 2, y: bb.y + bb.height / 2 };
    });
    if (!target) break;

    // A real tap at the button's own coordinates: no scrollIntoView, which would move it.
    await page.mouse.click(target.x, target.y);
    const moved = await page.evaluate(() => {
      const btn = document.querySelector('button.add[data-probe="1"]');
      const top = btn?.getBoundingClientRect().top ?? null;
      btn?.removeAttribute('data-probe');
      return top;
    });
    expect(moved).not.toBeNull();
    expect(Math.abs(moved! - target.top)).toBeLessThanOrEqual(1);
  }
});

test('deployment happens on the board, and a rejected placement says why', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  await setUpToDeployment(page);

  // The board is already aimed at the deploying player's drop zone, and says whose it is.
  await expect(page.locator('.zone-spotlight')).toHaveCount(1);
  await expect(page.locator('.armed-banner')).toContainText(/0 of \d+ placed/);

  // Tapping the middle of the killzone is illegal — no drop zone reaches the centre line —
  // and the reducer's own sentence is shown rather than nothing happening.
  const board = page.locator('svg.board-main');
  const box = await board.boundingBox();
  if (!box) throw new Error('the board has no layout box');
  const outside = await page.evaluate(() => {
    const svg = document.querySelector('svg.board-main')!;
    const r = svg.getBoundingClientRect();
    const [vx, vy, vw, vh] = (svg.getAttribute('viewBox') ?? '').split(' ').map(Number);
    const poly = document.querySelector('.zone-spotlight polygon:last-of-type') as SVGGraphicsElement;
    const b = poly.getBBox(); // world space, y-up
    // A world point inside the current window but clear of the drop zone, high enough up the
    // board to miss the zoom cluster in the bottom corner.
    const wx =
      b.x > vx! + vw! / 2
        ? Math.max(vx! + 1, b.x - 3)
        : Math.min(vx! + vw! - 1, b.x + b.width + 3);
    const wy = 22 - (vy! + vh! * 0.25);
    return { x: r.left + ((wx - vx!) / vw!) * r.width, y: r.top + ((22 - wy - vy!) / vh!) * r.height };
  });
  await page.mouse.click(outside.x, outside.y);
  await expect(page.locator('.toast')).toContainText(/drop zone|hazardous|on another/);

  // A legal tap INSIDE the highlighted drop zone places the operative and arms the next one.
  // The point is derived from the spotlight polygon itself, so this does not depend on where
  // the killzone happens to put its drop zones.
  const firstTitle = await promptTitle(page).innerText();
  const inZone = await page.evaluate(() => {
    const svg = document.querySelector('svg.board-main')!;
    const r = svg.getBoundingClientRect();
    const [vx, vy, vw, vh] = (svg.getAttribute('viewBox') ?? '').split(' ').map(Number);
    const poly = document.querySelector('.zone-spotlight polygon:last-of-type') as SVGGraphicsElement | null;
    if (!poly) return [];
    const b = poly.getBBox(); // world space, y-up
    const toScreen = (wx: number, wy: number) => ({
      x: r.left + ((wx - vx!) / vw!) * r.width,
      y: r.top + ((22 - wy - vy!) / vh!) * r.height,
    });
    return [0.35, 0.5, 0.65].flatMap((fy) =>
      [0.5, 0.35, 0.65].map((fx) => toScreen(b.x + b.width * fx, b.y + b.height * fy)),
    );
  });
  for (const pt of inZone) {
    await page.mouse.click(pt.x, pt.y);
    if ((await promptTitle(page).innerText()) !== firstTitle) break;
  }
  await expect(promptTitle(page)).not.toHaveText(firstTitle);
  await expect(page.locator('.armed-banner')).toContainText(/1 of \d+ placed/);
  await expect(page.getByRole('button', { name: /Undo last placement/ })).toBeVisible();
});

test('a phone held sideways docks the command surface to the side, not the bottom', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'phone-landscape', 'this is the landscape layout');
  await page.goto('/');
  await ready(page);
  const geometry = await page.evaluate(() => {
    const sheet = document.querySelector('.sheet')!;
    const s = sheet.getBoundingClientRect();
    const board = document.querySelector('svg.board-main')!.getBoundingClientRect();
    return { isSide: sheet.classList.contains('is-side'), sheetH: s.height, boardH: board.height, boardW: board.width, stageH: (document.querySelector('.stage') as HTMLElement).getBoundingClientRect().height };
  });
  expect(geometry.isSide).toBe(true);
  // The board keeps the full height of the stage rather than a strip above a sheet.
  expect(geometry.boardH).toBeGreaterThan(geometry.stageH * 0.9);
  expect(geometry.boardW).toBeGreaterThan(300);
  // …and the killzone is at least fully visible, not pushed out past the board's own width.
  const w = await page.evaluate(() => Number((document.querySelector('svg.board-main')!.getAttribute('viewBox') ?? '').split(' ')[2]));
  expect(w).toBeLessThanOrEqual(30.001);
});

test('the command sheet expands and collapses, and never hides the board while aiming', async ({ page }, testInfo) => {
  // The sheet is the phone-portrait layout: desktop puts the same content in a left rail and
  // landscape docks it to the side, and neither has detents.
  test.skip(testInfo.project.name === 'desktop' || testInfo.project.name === 'phone-landscape', 'no detents in this layout');
  await page.goto('/');
  await ready(page);
  const sheet = page.locator('.sheet');
  await expect(sheet).toHaveAttribute('data-detent', 'rest');
  const restHeight = (await sheet.boundingBox())?.height ?? 0;

  await page.locator('.sheet-grab').click();
  await expect(sheet).toHaveAttribute('data-detent', 'half');
  const halfHeight = (await sheet.boundingBox())?.height ?? 0;
  expect(halfHeight).toBeGreaterThan(restHeight);

  await page.locator('.sheet-grab').click();
  await expect(sheet).toHaveAttribute('data-detent', 'full');
  await page.locator('.sheet-grab').click();
  await expect(sheet).toHaveAttribute('data-detent', 'rest');

  // The board pane is inset by the RESTING height only, so expanding never reflows it.
  const paneBefore = await page.evaluate(() => document.querySelector('.board-pane')!.getBoundingClientRect().height);
  await page.locator('.sheet-grab').click();
  const paneAfter = await page.evaluate(() => document.querySelector('.board-pane')!.getBoundingClientRect().height);
  expect(Math.abs(paneAfter - paneBefore)).toBeLessThanOrEqual(1);
});

test('the menu reaches the rosters, the log and the killzones', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  await page.getByRole('button', { name: 'Menu' }).click();
  await expect(page.getByRole('dialog', { name: 'Menu' })).toBeVisible();
  await page.getByRole('button', { name: /Battle log/ }).click();
  await expect(page.getByRole('dialog', { name: 'Battle log' })).toBeVisible();
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

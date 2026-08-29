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

/**
 * Answer the opponent picker, which is now the first screen of the app.
 *
 * `mode` is the label on the row to choose; the default is the pass-and-play the rest of this
 * suite is written around. Every test that plays a battle goes through here, so the picker
 * cannot be skipped by accident and then silently leave a test asserting on the wrong screen.
 */
async function chooseOpponent(page: Page, mode: RegExp = /Pass and play/): Promise<void> {
  await expect(page.locator('.topbar')).toHaveAttribute('data-screen', 'setup.opponent');
  await page.locator('.sheet-body .actions button, .rail .actions button').filter({ hasText: mode }).first().click();
  await page.locator('.prompt .actions button[data-action="start"]').click();
  // The picker opens at `half` and the roll-off wants `rest`, so leaving this screen is the
  // one place in the app where the sheet animates before the next test step. `height` has a
  // 0.24s transition; measuring or tapping through it reads the previous screen's geometry.
  await settleSheet(page);
}

/** Wait for the sheet to stop animating: two identical heights, one frame apart. */
async function settleSheet(page: Page): Promise<void> {
  const sheet = page.locator('.sheet');
  if (!(await sheet.count())) return; // desktop mounts the same content in a rail
  let last = -1;
  for (let i = 0; i < 20; i++) {
    const h = (await sheet.boundingBox())?.height ?? 0;
    if (h === last) return;
    last = h;
    await page.waitForTimeout(60);
  }
}

const promptTitle = (page: Page) => page.locator('.prompt-title').first();

/** The plan id the shell is currently showing — the state, not the sentence. */
const screenId = (page: Page) => page.locator('.topbar').getAttribute('data-screen');

/** Drive setup as far as deployment: roll off, drop zone, two kill teams, reveal. */
async function setUpToDeployment(page: Page, opts: { equipment?: boolean } = {}): Promise<void> {
  await chooseOpponent(page);
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
    if (opts.equipment) {
      const pick = page.locator('.equipment-options button:not([disabled])').first();
      if (await pick.count()) await pick.click();
    }
    const confirm = page.getByRole('button', { name: /^Confirm — / });
    await expect(confirm).toBeEnabled();
    await confirm.click();
  }

  await page.getByRole('button', { name: /Reveal and deploy/ }).click();
  if (!opts.equipment) await expect(promptTitle(page)).toContainText(/^Place /);
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

test('the first screen asks who is playing, then says what to do', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  // Who is in the room decides who owns almost every screen after it, so it is asked first.
  await expect(promptTitle(page)).toContainText('Who is playing?');
  await chooseOpponent(page);
  await expect(promptTitle(page)).toContainText('Roll off for initiative');
  await expect(page.getByRole('button', { name: /Roll off/ })).toBeVisible();
  // The old shell's four tabs are gone: the sheet always shows the current step.
  await expect(page.getByRole('tab')).toHaveCount(0);
});

test('the board zooms and can be put back to the whole killzone', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  await chooseOpponent(page);
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
  await chooseOpponent(page);
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
  await chooseOpponent(page);
  const sheet = page.locator('.sheet');
  await expect(sheet).toHaveAttribute('data-detent', 'rest');
  const restHeight = (await sheet.boundingBox())?.height ?? 0;

  await page.locator('.sheet-grab').click();
  await expect(sheet).toHaveAttribute('data-detent', 'half');
  // `data-detent` flips on the click; the height follows it over 0.24s. Measure the end state,
  // not the frame the attribute changed on.
  await settleSheet(page);
  const halfHeight = (await sheet.boundingBox())?.height ?? 0;
  expect(halfHeight).toBeGreaterThan(restHeight);

  await page.locator('.sheet-grab').click();
  await expect(sheet).toHaveAttribute('data-detent', 'full');
  await page.locator('.sheet-grab').click();
  await expect(sheet).toHaveAttribute('data-detent', 'rest');

  // The board pane is inset by the RESTING height only, so expanding never reflows it.
  const paneBefore = await page.evaluate(() => document.querySelector('.board-pane')!.getBoundingClientRect().height);
  await page.locator('.sheet-grab').click();
  await settleSheet(page);
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


test('equipment chosen at the loadout is set up on the board before anyone deploys', async ({ page }) => {
  // The `placeEquipment` setup step existed in the types and the intent worked, but nothing
  // ever entered it, so a barricade or an Ammo Cache paid for at the loadout was simply never
  // placed. Both halves are pinned here: that the step is reached, and that it can be left.
  await page.goto('/');
  await ready(page);
  await setUpToDeployment(page, { equipment: true });

  expect(await screenId(page)).toBe('setup.placeEquipment');
  await expect(promptTitle(page)).toContainText(/^Set up |has no equipment to set up$/);

  // The legality field is the engine's own answer, sampled cell by cell — not a drop-zone
  // rectangle, because equipment constraints are per item and mostly are not the drop zone.
  await expect(page.locator('.reach rect').first()).toBeVisible();

  // Tapping a shaded cell sets the item up.
  const cell = await page.evaluate(() => {
    const cells = [...document.querySelectorAll('.reach rect')];
    const mid = cells[Math.floor(cells.length / 2)];
    if (!mid) return null;
    const b = mid.getBoundingClientRect();
    const ctrl = document.querySelector('.board-controls')?.getBoundingClientRect();
    const p = { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    if (ctrl && p.x > ctrl.left - 12 && p.x < ctrl.right + 12 && p.y > ctrl.top - 12 && p.y < ctrl.bottom + 12) return null;
    return p;
  });
  if (cell) {
    await page.mouse.click(cell.x, cell.y);
    await expect(page.locator('.toast')).toHaveCount(0);
  }

  // And there is always a way out, so an item with nowhere legal cannot strand the battle.
  for (let i = 0; i < 6; i++) {
    if ((await screenId(page)) !== 'setup.placeEquipment') break;
    await page.getByRole('button', { name: /Set up no more equipment|Nothing to set up/ }).first().click();
  }
  expect(await screenId(page)).toBe('setup.deploy');
});

test('the shell publishes which screen it is on', async ({ page }) => {
  // One attribute derived from the single `CommandPlan`, so a test can assert on the state
  // rather than on copy that keeps being edited.
  await page.goto('/');
  await ready(page);
  expect(await screenId(page)).toBe('setup.opponent');
  await chooseOpponent(page);
  expect(await screenId(page)).toBe('setup.rollOff');
  await page.getByRole('button', { name: /Roll off/ }).click();
  expect(await screenId(page)).toMatch(/^setup\.(initiative|dropZone)$/);
});


test('a screen that arms the board still shows the list it tells you to pick from', async ({ page }) => {
  // The regression this pins cost the whole battle. Two effects set the sheet's detent — the
  // plan's own, and "a screen that arms the board must not be covered by its own sheet" — and
  // the second ran last, so it won. `firefight.activate` arms the board AND asks for `half`
  // ("tap one of your ringed operatives, or pick it from the list below"): forced to `rest`,
  // the list rendered ~75px below the bottom of the screen. For four turning points the only
  // way to activate anyone was to hit a 44px token on the board.
  await page.goto('/');
  await ready(page);
  await setUpToDeployment(page);

  // Deploy everyone by tapping the highlighted drop zone.
  for (let i = 0; i < 400; i++) {
    if ((await screenId(page)) !== 'setup.deploy') break;
    const p = await page.evaluate((k) => {
      const svg = document.querySelector('svg.board-main');
      if (!svg) return null;
      const r = svg.getBoundingClientRect();
      const ctrl = document.querySelector('.board-controls')?.getBoundingClientRect();
      const pts: { x: number; y: number }[] = [];
      for (const poly of document.querySelectorAll('.legal-zone')) {
        const b = poly.getBoundingClientRect();
        if (b.width < 4 || b.height < 4) continue;
        // A fine grid: 18 operatives need 18 spots that do not overlap each other, and on a
        // desktop-width board the drop zone is a narrow strip where a coarse grid runs out.
        for (let i = 1; i <= 7; i++) for (let j = 1; j <= 11; j++)
          pts.push({ x: b.left + (b.width * i) / 8, y: b.top + (b.height * j) / 12 });
      }
      const ok = pts.filter((s) =>
        s.x > r.left + 8 && s.x < r.right - 8 && s.y > r.top + 8 && s.y < r.bottom - 8 &&
        // The floating zoom cluster is a real button and would eat the tap.
        !(ctrl && s.x > ctrl.left - 12 && s.x < ctrl.right + 12 && s.y > ctrl.top - 12 && s.y < ctrl.bottom + 12));
      return ok.length ? ok[(k * 13) % ok.length]! : null;
    }, i);
    if (!p) break;
    await page.mouse.click(p.x, p.y);
  }
  expect(await screenId(page), 'every operative should be deployed by now').toBe('setup.deployDone');
  await page.getByRole('button', { name: /Begin the battle/ }).click();

  // Walk the strategy phase to the first activation.
  for (let i = 0; i < 40; i++) {
    if ((await screenId(page)) === 'firefight.activate') break;
    const next = page.locator('.prompt .actions button:not([disabled])').first();
    if (!(await next.count())) break;
    await next.click();
  }
  expect(await screenId(page)).toBe('firefight.activate');

  // The list the prompt points at must be on screen and clickable, not below the fold — in
  // whichever layout this viewport gets: a bottom sheet on a phone, a side sheet in landscape,
  // a rail on the desktop. The bottom sheet is the one that has to open itself.
  const sheet = page.locator('.sheet');
  if (await sheet.count()) {
    const detent = await sheet.getAttribute('data-detent');
    // 'side' is a landscape sheet, which is a fixed column and always fully open.
    expect(detent === 'half' || detent === 'full' || detent === 'side', `sheet is at '${detent}'`).toBe(true);
  }
  const pick = page.locator('.sheet-body .actions button, .rail .actions button').first();
  await expect(pick).toBeVisible();
  const box = (await pick.boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  await pick.click({ timeout: 3000 });
  expect(await screenId(page)).toBe('firefight.order');
});

/* ------------------------------------------------------------ the AI opponent */

test('the AI plays its own side, and never asks the solo player to hand over the phone', async ({ page }) => {
  // Everything about the AI opponent that a person actually sees: the picker, the opponent's
  // own screen, a kill team it chose for itself, and — the thing a solo game most obviously
  // must not do — no "hand the device to Player 2" between the screens that are secret in a
  // two-player battle.
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/');
  await ready(page);
  await chooseOpponent(page, /you are Player 1/);

  const handovers: string[] = [];
  const watchForHandover = async () => {
    const id = await screenId(page);
    if (id && /handover/i.test(id)) handovers.push(id);
    return id;
  };

  await page.getByRole('button', { name: /Roll off/ }).click();
  for (let i = 0; i < 60; i++) {
    const id = await watchForHandover();
    if (id === 'setup.initiative') await page.getByRole('button', { name: /Take initiative/ }).click();
    else if (id === 'setup.dropZone') await page.getByRole('button', { name: /Take the orange drop zone/ }).click();
    else if (id === 'ai.acting') await page.waitForTimeout(200);
    else break;
  }

  // The player's own kill team, chosen the ordinary way.
  for (let i = 0; i < 80 && (await watchForHandover()) !== 'setup.selectOperatives'; i++) await page.waitForTimeout(200);
  await page.getByRole('button', { name: /Choose operatives/ }).click();
  await page.locator('.team-list button').first().click();
  for (let i = 0; i < 25; i++) {
    const add = page.locator('button.add:not([disabled])').first();
    if (!(await add.count())) break;
    await add.click();
  }
  await page.getByRole('button', { name: /Lock in Player/ }).click();

  for (let i = 0; i < 80 && (await watchForHandover()) !== 'setup.loadout'; i++) await page.waitForTimeout(200);
  await page.locator('.tac-ops button').first().click();
  await page.locator('.prompt .actions button[data-action="confirm-loadout"]').click();

  // …and by the reveal the AI has quietly done all of its own: kill team, equipment, tac op.
  for (let i = 0; i < 120 && (await watchForHandover()) !== 'setup.reveal'; i++) await page.waitForTimeout(200);
  expect(await screenId(page)).toBe('setup.reveal');
  await expect(page.locator('.team-card.is-p2 .entry-name')).not.toBeEmpty();
  await expect(page.locator('.team-card.is-p2 .entry-meta')).toContainText(/\d+ operatives/);

  expect(handovers, 'a solo game has nobody to hand the phone to').toEqual([]);
  expect(errors).toEqual([]);
});

test('watching the AI play itself needs no input at all', async ({ page }) => {
  // The strongest end-to-end statement the app can make about the driver: with both seats
  // driven it also owns the beats that belong to nobody — the roll-off, the ready step, the
  // end-of-turning-point score — so a battle runs from the picker to the firefight with no
  // click after "Play".
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/');
  await ready(page);
  await chooseOpponent(page, /Watch the AI play itself/);

  let reached = '';
  for (let i = 0; i < 900; i++) {
    const w = await page.evaluate(() => ({
      id: document.querySelector('.topbar')?.getAttribute('data-screen') ?? '',
      // `textContent`, not `innerText`: `.prompt-step` is uppercased in CSS, and `innerText`
      // returns what is painted.
      step: document.querySelector('.prompt-step')?.textContent ?? '',
      help: document.querySelector('.prompt-help')?.textContent ?? '',
    }));
    if (w.id === 'ai.error') throw new Error(`the AI stopped: ${w.help}`);
    if (/Firefight/.test(w.step) || w.id === 'battleEnd') {
      reached = w.id === 'battleEnd' ? 'battleEnd' : w.step;
      break;
    }
    await page.waitForTimeout(200);
  }
  expect(reached, 'a watched battle should reach the firefight on its own').toMatch(/Firefight|battleEnd/);
  // Two kill teams are on the killzone, chosen and deployed with no human input.
  expect(await page.locator('svg.board-main g.operatives > *').count()).toBeGreaterThan(4);
  expect(errors).toEqual([]);
});

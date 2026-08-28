// Re-capture docs/ui-review/ by playing a real battle at three viewports.
//
//   pnpm ui:review              # phone, phone-landscape, desktop
//   pnpm ui:review -- --only phone            # or --only phone,desktop
//   PW_CHROMIUM=/path/to/chrome pnpm ui:review
//
// The screenshots are the input to a visual review, not fixtures, so nothing here asserts.
// What it DOES enforce is that every named screen was actually reached and that the console
// stayed clean: it exits non-zero if a viewport misses a required screen or logs an error,
// because a capture of the screens the app still manages to reach is worse than no capture.
//
// The battle is played, not faked. There is no seam for injecting a state — `App` builds its
// own Store — and that is the point: every PNG here is a state the app reached through its own
// UI, which is why the defence allocator, a re-roll window and the mid-battle handover appear
// at all. Screens that depend on the dice (a re-roll offer, an obscured discard) are captured
// opportunistically; the numbered set below is required.
//
// Adding a screen: give it a number in SHOTS, then snap it from the handler for the screen id
// that shows it. Handlers are keyed by the `data-screen` the topbar publishes, so they follow
// `commandPlan` rather than a script of clicks — a new branch there needs a new handler here,
// not a re-ordering of the old ones.

import { chromium, devices } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdir, readdir, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(ROOT, 'docs', 'ui-review');
const PORT = 4173;
const BASE = `http://127.0.0.1:${PORT}/kill-team-mobile/`;

/**
 * A mainstream phone, that phone held sideways, and a desktop. Not the iPhone SE: `docs/UI.md`
 * covers the 568px case in prose, and a review set is more useful when consecutive captures
 * are comparable, so this stays on the 390-wide device the previous set used. The landscape
 * device is the one `playwright.config.ts` pins for its `phone-landscape` project.
 */
const VIEWPORTS = [
  { prefix: 'phone', use: devices['iPhone 13'] },
  { prefix: 'phone-landscape', use: devices['iPhone 13 landscape'] },
  { prefix: 'desktop', use: { viewport: { width: 1440, height: 900 } } },
];

/** Every numbered screen, in flow order. `required: false` = only if the dice go that way. */
const SHOTS = [
  ['01-first-screen'],
  ['02-sheet-half'],
  ['03-sheet-full'],
  ['04-menu'],
  ['05-initiative'],
  ['06-drop-zone'],
  ['07-handover'],
  ['08-team-picker'],
  ['09-builder-empty'],
  ['10-builder-full'],
  ['11-loadout'],
  ['12-loadout-chosen'],
  ['13-reveal'],
  ['13b-equipment'],
  ['13c-equipment-placed'],
  ['14-deploy'],
  ['15-deploy-rejected'],
  ['16-deployed'],
  ['17-decision-primary-op', false],
  ['18-activate'],
  ['19-order'],
  ['20-action-sheet'],
  ['21-action-sheet-open'],
  ['22-move-armed'],
  ['23-move-aimed'],
  ['24-after-move'],
  ['25-end-of-turning-point'],
  ['26-shoot-targets'],
  ['27-allocate-defence', false],
  ['28-battle-end'],
  ['29-reroll', false],
  ['30-handover-mid-battle', false],
];
const REQUIRED = SHOTS.filter(([, req]) => req !== false).map(([n]) => n);

/** Reactive windows that get a numbered slot of their own; anything else is `decision-<kind>`. */
const DECISION_SHOT = {
  primaryOp: '17-decision-primary-op',
  allocateDefence: '27-allocate-defence',
  reroll: '29-reroll',
};

/* ----------------------------------------------------------------- plumbing */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const listening = (port) =>
  new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    s.on('connect', () => (s.end(), resolve(true)));
    s.on('error', () => resolve(false));
  });

/** `vite preview` over the build Pages deploys — captured from `dist/`, not the dev server. */
async function serve() {
  if (await listening(PORT)) return () => {};
  const build = spawn('pnpm', ['build'], { cwd: ROOT, stdio: 'inherit' });
  const code = await new Promise((r) => build.on('exit', r));
  if (code !== 0) throw new Error(`pnpm build exited ${code}`);
  const child = spawn('pnpm', ['preview', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: 'ignore' });
  for (let i = 0; i < 120; i++) {
    if (await listening(PORT)) return () => child.kill();
    await sleep(500);
  }
  child.kill();
  throw new Error('vite preview never came up');
}

/* --------------------------------------------------------- page vocabulary */

const screen = (page) => page.locator('.topbar').getAttribute('data-screen');
const title = (page) => page.locator('.prompt-title').first().innerText();

/**
 * Where the battle is, in one round trip — and, between them, the three lines that count
 * DOWN as the battle is played: the activation screen's help reads "2 of 3 AP left", the
 * armed banner reads "7 ready" and "3 of 9 placed". They are the cheap DOM signal that an
 * action was actually spent rather than offered and cancelled, which is what tells a genuine
 * cycle from a screen the battle legitimately returns to nine times in a row.
 */
const where = (page) =>
  page.evaluate(() => ({
    id: document.querySelector('.topbar')?.getAttribute('data-screen') ?? null,
    title: document.querySelector('.prompt-title')?.textContent ?? '',
    help: document.querySelector('.prompt-help')?.textContent ?? '',
    banner: document.querySelector('.armed-banner')?.textContent ?? '',
  }));

/** Plan actions live in the peek on a phone and in the left rail on a desktop; same buttons. */
const action = (page, id) => page.locator(`.prompt .actions button[data-action="${id}"]:not([disabled])`);
/** Anything the plan's BODY renders — the team list, the action list, the target list. */
const bodyButtons = (page) => page.locator('.sheet-body .actions button:not([disabled]), .rail .actions button:not([disabled])');

async function click(loc, page) {
  if (!(await loc.count())) return false;
  await loc.first().click({ timeout: 5000, force: true });
  await settle(page);
  return true;
}

/** One frame plus the sheet's transition — long enough that a screenshot is not mid-animation. */
const settle = (page) => page.waitForTimeout(90);

/** Drag the bottom sheet to a detent. Only phone portrait has detents; the rest are no-ops. */
async function detent(page, want) {
  const sheet = page.locator('.sheet');
  if (!(await sheet.count())) return;
  for (let i = 0; i < 4; i++) {
    if ((await sheet.getAttribute('data-detent')) === want) return;
    const grab = page.locator('.sheet-grab');
    if (!(await grab.count())) return;
    await grab.click();
    await page.waitForTimeout(260);
  }
}

/* ------------------------------------------------------------------- board */

/**
 * World inches → client pixels, through the board's live viewBox. Everything that taps the
 * killzone goes through this rather than through a fraction of the pane, because the board
 * pans and zooms itself to each screen's `frame`.
 *
 * The 22 is the killzone's height in inches: world y is up from the bottom-left origin and the
 * viewBox is y-down, so the flip needs the board's own height. Every killzone the app can boot
 * into is 30×22, and `e2e/smoke.spec.ts` assumes the same.
 */
const TO_SCREEN = `(wx, wy) => {
  const svg = document.querySelector('svg.board-main');
  const r = svg.getBoundingClientRect();
  const [vx, vy, vw, vh] = (svg.getAttribute('viewBox') ?? '').split(' ').map(Number);
  return { x: r.left + ((wx - vx) / vw) * r.width, y: r.top + ((22 - wy - vy) / vh) * r.height };
}`;

/** The floating zoom cluster is a real button and would eat any tap that lands under it. */
const CLEAR_OF_CONTROLS = `(() => {
  const svg = document.querySelector('svg.board-main').getBoundingClientRect();
  const c = document.querySelector('.board-controls')?.getBoundingClientRect();
  return (p) =>
    p.x > svg.left + 8 && p.x < svg.right - 8 && p.y > svg.top + 8 && p.y < svg.bottom - 8 &&
    !(c && p.x > c.left - 12 && p.x < c.right + 12 && p.y > c.top - 12 && p.y < c.bottom + 12);
})()`;

/** A point inside the highlighted legality field — the drop zone, or a move's reach. */
const pointsIn = (page, selector, spread = 5) =>
  page.evaluate(
    ([sel, n, clear]) => {
      const ok = eval(clear);
      const pts = [];
      for (const el of document.querySelectorAll(sel)) {
        const b = el.getBoundingClientRect();
        if (b.width < 2 || b.height < 2) continue;
        for (let i = 1; i <= n; i++)
          for (let j = 1; j <= n + 2; j++)
            pts.push({ x: b.left + (b.width * i) / (n + 1), y: b.top + (b.height * j) / (n + 3) });
      }
      return pts.filter(ok);
    },
    [selector, spread, CLEAR_OF_CONTROLS],
  );

/* ------------------------------------------------------------------ driver */

class Capture {
  constructor(page, prefix, errors) {
    this.page = page;
    this.prefix = prefix;
    this.errors = errors;
    this.taken = new Set();
    this.deployTaps = 0;
    /**
     * `${operative}|${row}` for every action row that was offered, armed, and then could not
     * be committed — a weapon whose targets all turn out to be unshootable, a move with no
     * legal destination in reach. Without this the driver picks the same top row for ever.
     */
    this.blocked = new Set();
    this.armed = null;
  }

  /** Screenshots are once-only: a screen the battle revisits keeps its first, in-flow shot. */
  async snap(name) {
    if (this.taken.has(name)) return;
    this.taken.add(name);
    await settle(this.page);
    await this.page.screenshot({ path: join(OUT, `${this.prefix}-${name}.png`) });
  }
}

/**
 * One handler per `data-screen`. Each snaps whatever the screen is the only place to see, then
 * advances the battle by one step. Returning is enough — the loop re-reads the screen id.
 */
const HANDLERS = {
  'setup.rollOff': async (c) => {
    await c.snap('01-first-screen');
    await detent(c.page, 'half');
    await c.snap('02-sheet-half');
    await detent(c.page, 'full');
    await c.snap('03-sheet-full');
    await detent(c.page, 'rest');

    await c.page.getByRole('button', { name: 'Menu' }).click();
    await c.page.waitForTimeout(200);
    await c.snap('04-menu');
    await click(c.page.getByRole('button', { name: 'Back' }), c.page);

    await click(action(c.page, 'roll'), c.page);
  },

  'setup.initiative': async (c) => {
    await c.snap('05-initiative');
    await click(action(c.page, 'take'), c.page);
  },

  'setup.dropZone': async (c) => {
    await c.snap('06-drop-zone');
    await click(c.page.locator('.prompt .actions button:not([disabled])'), c.page);
  },

  'setup.handover': async (c) => {
    await c.snap('07-handover');
    await click(c.page.locator('.prompt .actions button:not([disabled])'), c.page);
  },

  'setup.selectOperatives': async (c) => {
    const teams = c.page.locator('.team-list button');
    if (await teams.count()) {
      await c.snap('08-team-picker');
      await click(teams, c.page);
      await c.snap('09-builder-empty');
    }
    // Fill the roster to its limit: `add` disables itself as each constraint is met.
    for (let i = 0; i < 30; i++) {
      const add = c.page.locator('button.add:not([disabled])').first();
      if (!(await add.count())) break;
      await add.click();
      await c.page.waitForTimeout(30);
    }
    await c.snap('10-builder-full');
    await click(c.page.getByRole('button', { name: /Lock in Player/ }), c.page);
  },

  'setup.loadoutHandover': async (c) => {
    await click(c.page.locator('.prompt .actions button:not([disabled])'), c.page);
  },

  'setup.loadout': async (c) => {
    await c.snap('11-loadout');
    // The tac op is not optional: it is the only thing that calls `ctx.initOps`.
    await click(c.page.locator('.tac-ops button:not([disabled])'), c.page);
    await click(c.page.locator('.equipment-options button:not([disabled])'), c.page);
    await c.snap('12-loadout-chosen');
    await click(c.page.getByRole('button', { name: /^Confirm — / }), c.page);
  },

  'setup.reveal': async (c) => {
    await c.snap('13-reveal');
    await click(c.page.locator('.prompt .actions button:not([disabled])'), c.page);
  },

  'setup.placeEquipment': async (c) => {
    await c.snap('13b-equipment');
    const pts = await pointsIn(c.page, '.reach rect', 3);
    if (pts.length) {
      const before = await title(c.page);
      await c.page.mouse.click(pts[Math.floor(pts.length / 2)].x, pts[Math.floor(pts.length / 2)].y);
      await settle(c.page);
      if ((await title(c.page)) !== before) await c.snap('13c-equipment-placed');
    }
    // There is always a way out, so an item with nowhere legal cannot strand the battle.
    if ((await screen(c.page)) === 'setup.placeEquipment' && !pts.length)
      await click(c.page.getByRole('button', { name: /Set up no more equipment|Nothing to set up/ }), c.page);
  },

  'setup.deploy': async (c, s) => {
    await c.snap('14-deploy');

    // A tap outside the highlighted zone is answered in the reducer's own words. Worth one
    // shot: "nothing happened" was the single most confusing thing about the old shell.
    if (!c.taken.has('15-deploy-rejected')) {
      const outside = await c.page.evaluate(
        ([toScreen, clear]) => {
          const to = eval(toScreen);
          const ok = eval(clear);
          const poly = document.querySelector('.zone-spotlight polygon:last-of-type');
          if (!poly) return [];
          const svg = document.querySelector('svg.board-main');
          const [vx, , vw] = (svg.getAttribute('viewBox') ?? '').split(' ').map(Number);
          const b = poly.getBBox(); // world space, y-up
          // Clear of the drop zone, but still inside the window the board is showing.
          const wx = b.x > vx + vw / 2 ? Math.max(vx + 1, b.x - 3) : Math.min(vx + vw - 1, b.x + b.width + 3);
          return [11, 14, 8, 17, 5].map((wy) => to(wx, wy)).filter(ok);
        },
        [TO_SCREEN, CLEAR_OF_CONTROLS],
      );
      for (const p of outside) {
        await c.page.mouse.click(p.x, p.y);
        await c.page.waitForTimeout(150);
        if (await c.page.locator('.toast').count()) {
          await c.snap('15-deploy-rejected');
          break;
        }
      }
    }

    // One placement per pass: the prompt names the next operative, so the loop re-frames.
    // The start index walks, because operative N+1 cannot stand where operative N is and
    // restarting the grid every time would spend the whole scan on occupied ground.
    const before = await title(c.page);
    const pts = await pointsIn(c.page, '.legal-zone', 7);
    for (let i = 0; i < pts.length; i++) {
      const p = pts[(i * 13 + c.deployTaps * 7) % pts.length];
      await c.page.mouse.click(p.x, p.y);
      await settle(c.page);
      if ((await title(c.page)) !== before || (await screen(c.page)) !== 'setup.deploy') {
        c.deployTaps += 1;
        return;
      }
    }
    s.stuck = 'nowhere legal left to deploy';
  },

  'setup.deployDone': async (c) => {
    await c.snap('16-deployed');
    await click(action(c.page, 'begin'), c.page);
  },

  'strategy.initiative': async (c) => {
    await click(c.page.locator('.prompt .actions button:not([disabled])'), c.page);
  },

  'strategy.gambit': async (c) => {
    // Passing, not spending: a gambit is a real choice and the capture should not make it.
    await click(action(c.page, 'pass'), c.page);
  },

  'firefight.activate': async (c) => {
    await c.snap('18-activate');
    if (!(await click(bodyButtons(c.page), c.page))) await click(c.page.locator('.prompt .actions button:not([disabled])'), c.page);
  },

  'firefight.order': async (c) => {
    await c.snap('19-order');
    await click(action(c.page, 'engage'), c.page);
  },

  'firefight.act': async (c) => {
    await c.snap('20-action-sheet');
    if (!c.taken.has('21-action-sheet-open')) {
      await detent(c.page, 'full');
      await c.snap('21-action-sheet-open');
      await detent(c.page, 'half');
    }
    await chooseAction(c);
  },

  'firefight.counteracting': async (c) => {
    await chooseAction(c);
  },

  'firefight.move': async (c) => {
    await c.snap('22-move-armed');
    // Walk toward the middle: the shooting screens only exist once somebody is in range.
    const pts = await pointsIn(c.page, '.reach rect', 1);
    if (pts.length) {
      const mid = await c.page.evaluate(([toScreen]) => eval(toScreen)(15, 11), [TO_SCREEN]);
      pts.sort((a, b) => Math.hypot(a.x - mid.x, a.y - mid.y) - Math.hypot(b.x - mid.x, b.y - mid.y));
      for (const p of pts.slice(0, 6)) {
        await c.page.mouse.click(p.x, p.y);
        await settle(c.page);
        if (await action(c.page, 'confirm-move').count()) break;
      }
      await c.snap('23-move-aimed');
    }
    if (await click(action(c.page, 'confirm-move'), c.page)) {
      await c.snap('24-after-move');
      return;
    }
    if (c.armed) c.blocked.add(c.armed);
    await click(action(c.page, 'cancel-move'), c.page);
  },

  'firefight.aim': async (c) => {
    if (!(await click(bodyButtons(c.page), c.page))) await click(action(c.page, 'cancel'), c.page);
  },

  'firefight.shoot': async (c) => {
    await c.snap('26-shoot-targets');
    await click(bodyButtons(c.page), c.page);
    if (await click(action(c.page, 'fire'), c.page)) return;
    if (c.armed) c.blocked.add(c.armed);
    await click(action(c.page, 'cancel-shoot'), c.page);
  },

  'firefight.expended': async (c) => {
    await click(action(c.page, 'advance'), c.page);
  },

  'firefight.counteract': async (c) => {
    await click(action(c.page, 'decline'), c.page);
  },

  'firefight.guardInterrupt': async (c) => {
    await click(action(c.page, 'decline-interrupt'), c.page);
  },

  'firefight.guardInterrupt.target': async (c) => {
    if (!(await click(bodyButtons(c.page), c.page))) await click(action(c.page, 'back'), c.page);
  },

  endOfTP: async (c) => {
    await c.snap('25-end-of-turning-point');
    await click(action(c.page, 'advance'), c.page);
  },

  'decision.handover': async (c) => {
    await c.snap('30-handover-mid-battle');
    await click(c.page.locator('.prompt .actions button:not([disabled])'), c.page);
  },

  'decision.allocateDefence': async (c) => {
    await c.snap('27-allocate-defence');
    if (!(await click(action(c.page, 'auto'), c.page))) await click(action(c.page, 'take'), c.page);
  },

  battleEnd: async (c, s) => {
    await c.snap('28-battle-end');
    s.done = true;
  },
};

/**
 * The activation screen: fight what is already in contact, else shoot with whatever has the
 * most targets, else walk toward the middle, else end the activation.
 *
 * This is not an AI and must not become one — `src/ai/` exists for that. It only has to reach
 * the screens: a battle where nobody ever fires never opens the target list, the defence
 * allocator or a re-roll window, which is exactly the hole the previous capture had.
 */
async function chooseAction(c) {
  const who = (await where(c.page)).title;
  const pick = await c.page.evaluate(
    ([blocked, who]) => {
      const groups = [...document.querySelectorAll('.sheet-body .actions, .rail .actions')];
      const section = (name) => groups.find((g) => g.querySelector('.section-title')?.textContent === name);
      const label = (b) => b.querySelector('span')?.textContent?.trim() ?? '';
      const free = (b) => !blocked.includes(`${who}|${label(b)}`);

      const fight = [...(section('Fight')?.querySelectorAll('button:not([disabled])') ?? [])].filter(free);
      if (fight.length) return { row: label(fight[0]), kind: 'fight' };

      let best = null;
      for (const b of section('Shoot')?.querySelectorAll('button:not([disabled])') ?? []) {
        const n = Number(/(\d+) target/.exec(b.textContent ?? '')?.[1] ?? 0);
        if (n > 0 && free(b) && (!best || n > best.n)) best = { n, row: label(b), kind: 'shoot' };
      }
      if (best) return best;

      const move = [...(section('Actions')?.querySelectorAll('button:not([disabled])') ?? [])]
        .filter(free)
        .find((b) => /Normal Move|Reposition|Dash|Charge/.test(label(b)));
      return move ? { row: label(move), kind: 'move' } : null;
    },
    [[...c.blocked], who],
  );

  if (!pick) {
    await click(action(c.page, 'end'), c.page);
    return;
  }
  // What the next screen has to blame if it cannot commit what this row armed.
  c.armed = `${who}|${pick.row}`;
  const btn = c.page
    .locator('.sheet-body .actions button:not([disabled]), .rail .actions button:not([disabled])')
    .filter({ hasText: pick.row });
  if (!(await click(btn, c.page))) {
    c.blocked.add(c.armed);
    await click(action(c.page, 'end'), c.page);
  }
}

/* -------------------------------------------------------------------- main */

async function capture(browser, { prefix, use }) {
  process.stderr.write(`\n${prefix}\n`);
  const errors = [];
  const context = await browser.newContext({ ...use });
  const page = await context.newPage();
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(BASE);
  await page.locator('svg.board-main').waitFor({ state: 'visible', timeout: 30_000 });

  const c = new Capture(page, prefix, errors);
  const state = { done: false, stuck: null };
  /**
   * A cycle breaker, not a step limit. Two screens can hand back and forth for ever without
   * either repeating consecutively — `firefight.act` offers a shot, `firefight.shoot` finds it
   * cannot fire and cancels back — so what is watched is the recent history of
   * (screen, prompt title), and the escape is to end the activation rather than to give up.
   */
  const recent = [];
  let lastLogged = null;
  const t0 = Date.now();

  for (let step = 0; step < 6000 && !state.done && !state.stuck; step++) {
    const { id, title: t, help, banner } = await where(page);
    const key = `${id}|${t}|${help}|${banner}`;
    recent.push(key);
    if (recent.length > 40) recent.shift();

    if (id !== lastLogged) {
      lastLogged = id;
      process.stderr.write(`  ${String(step).padStart(4)}  ${((Date.now() - t0) / 1000).toFixed(1)}s  ${id}\n`);
    }

    // A reactive window is allowed to repeat itself: one shooting sequence offers the same
    // "re-roll any number of dice" prompt to each side, more than once, word for word. Only a
    // gameplay screen that has not moved is evidence of a cycle.
    const limit = id?.startsWith('decision.') ? 12 : 6;
    if (recent.filter((k) => k === key).length >= limit) {
      recent.length = 0;
      process.stderr.write(`  ${String(step).padStart(4)}  going in circles on ${id} — taking the last option\n`);
      if (!(await click(action(page, 'end'), page)))
        if (!(await click(action(page, 'advance'), page)))
          if (!(await click(page.locator('.prompt .actions button:not([disabled])').last(), page)))
            // `firefight.activate` has no plan actions at all — the way on is the list.
            if (!(await click(bodyButtons(page), page))) {
              state.stuck = `going in circles on ${id}`;
              break;
            }
      continue;
    }

    const handler = HANDLERS[id];
    if (handler) {
      await handler(c, state);
      continue;
    }

    // Any reactive window without a screen of its own: snap the ones with a numbered slot,
    // then take the option the engine itself marks as the default.
    if (id?.startsWith('decision.')) {
      const kind = id.slice('decision.'.length);
      // A team's own window is namespaced (`celestian.martyrdom`); keep the name a plain slug.
      await c.snap(DECISION_SHOT[kind] ?? `decision-${kind.replace(/[^a-zA-Z0-9]+/g, '-')}`);
      if (!(await click(c.page.locator('.prompt .actions button:not([disabled])'), page)))
        await click(bodyButtons(page), page);
      continue;
    }

    if (!(await click(page.locator('.prompt .actions button:not([disabled])'), page)))
      if (!(await click(bodyButtons(page), page))) {
        state.stuck = `no way forward from ${id}`;
        break;
      }
  }

  await context.close();
  const missing = REQUIRED.filter((n) => !c.taken.has(n));
  return { prefix, missing, errors, stuck: state.stuck, taken: [...c.taken] };
}

async function main() {
  const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
  const names = only ? only.split(',').map((n) => n.trim()) : null;
  const wanted = names ? VIEWPORTS.filter((v) => names.includes(v.prefix)) : VIEWPORTS;
  if (!wanted.length) throw new Error(`--only ${only} matches no viewport`);

  await mkdir(OUT, { recursive: true });
  // A stale PNG from a screen that no longer exists is worse than a missing one. The owning
  // viewport is the LONGEST prefix that matches, or `--only phone` would also wipe
  // `phone-landscape-*`.
  const byLength = [...VIEWPORTS].sort((a, b) => b.prefix.length - a.prefix.length);
  for (const f of await readdir(OUT)) {
    if (!f.endsWith('.png')) continue;
    const owner = byLength.find((v) => f.startsWith(`${v.prefix}-`));
    if (owner && wanted.includes(owner)) await unlink(join(OUT, f));
  }

  const stop = await serve();
  const browser = await chromium.launch(
    process.env['PW_CHROMIUM'] ? { executablePath: process.env['PW_CHROMIUM'], args: ['--no-sandbox'] } : {},
  );

  const results = [];
  try {
    for (const v of wanted) results.push(await capture(browser, v));
  } finally {
    await browser.close();
    stop();
  }

  let bad = false;
  for (const r of results) {
    console.log(`\n${r.prefix}: ${r.taken.length} screens`);
    if (r.stuck) (bad = true), console.log(`  STUCK: ${r.stuck}`);
    if (r.missing.length) (bad = true), console.log(`  MISSING: ${r.missing.join(', ')}`);
    if (r.errors.length) (bad = true), console.log(`  CONSOLE: ${[...new Set(r.errors)].join('\n            ')}`);
  }
  if (bad) process.exitCode = 1;
}

await main();

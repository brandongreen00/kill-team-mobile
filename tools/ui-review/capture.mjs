// Headless mobile-viewport screenshot + a11y capture for every page in the app.
//
// Usage:
//   cd tools/ui-review
//   npm install
//   npm run install-browser   # once, downloads chromium for playwright
//   npm run capture           # writes screenshots/<scenario>__<device>__{viewport,page}.png
//                             #     plus screenshots/<scenario>__<device>.a11y.json
//
// What it does:
//   1. Boots a Python static server pointed at the repo root.
//   2. For each (device profile × scenario), opens a fresh Playwright
//      browser context with the device's mobile viewport / DPR / UA / touch.
//   3. Optionally seeds localStorage and sessionStorage *before* page scripts
//      run (via addInitScript), so that screens requiring saved rosters or a
//      chosen map render with realistic content rather than empty states.
//   4. Optionally drives the page through scripted clicks (`setup` per
//      scenario) to land on phases that only exist after user input — the
//      initiative roll, the deploy entry, etc.
//   5. Captures TWO screenshots per scenario:
//        __viewport.png — initial viewport only. The only place position:fixed
//                         elements (e.g. map-creator's bottom action bar)
//                         render where they actually pin.
//        __page.png     — the full scrollable page. Best for in-flow content
//                         review, but renders position:fixed elements at a
//                         misleading position partway down the image.
//   6. Runs axe-core against the page and writes <name>.a11y.json with any
//      violations. Also writes <name>.errors.txt for non-noise console errors.
//
// To add a new scenario, push to SCENARIOS. `setup` runs after navigation
// and before screenshots; throw to abort the scenario. Math.random is stubbed
// to a fixed sequence so dice rolls / shuffles are deterministic.

import { chromium, devices } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import net from 'node:net';
import { sampleRosters, defaultMapId } from './fixtures.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const OUT_DIR = join(__dirname, 'screenshots');
const PORT = 8123;
const BASE = `http://127.0.0.1:${PORT}`;

const DEVICE_PROFILES = [
  { name: 'iphone-se', device: devices['iPhone SE'] },
  { name: 'iphone-14', device: devices['iPhone 14'] },
  { name: 'pixel-7',   device: devices['Pixel 7'] },
];

// Helpers reused by setup steps.
const clickConfirmedTeams = async (page) => {
  // Pick the first roster for team A, the second for team B, then confirm.
  await page.locator('#roster-list-A .roster-pick-card').first().click();
  await page.locator('#roster-list-B .roster-pick-card').nth(1).click();
  await page.locator('#confirm-teams').click();
};

const rollInitiativeUntilWinner = async (page) => {
  // Math.random is stubbed deterministic, so the first roll resolves cleanly,
  // but loop a few times defensively in case the stub sequence ever changes.
  for (let i = 0; i < 3; i++) {
    await page.locator('#roll-btn').click();
    // Roll animation is 900ms; wait a bit longer for the settle frame.
    await page.waitForTimeout(1100);
    const chooseVisible = await page.locator('#initiative-choose').isVisible();
    if (chooseVisible) return;
  }
  throw new Error('initiative kept tying — random stub may be broken');
};

const SCENARIOS = [
  // Static / pre-game screens.
  { name: 'index',             path: '/index.html',        seed: '' },
  { name: 'maps',              path: '/maps.html',         seed: '' },
  { name: 'map-creator',       path: '/map-creator.html',  seed: '' },
  { name: 'roster-empty',      path: '/roster.html',       seed: '' },
  { name: 'roster-populated',  path: '/roster.html',       seed: 'rosters' },
  {
    name: 'roster-faction-picker',
    path: '/roster.html',
    seed: '',
    setup: async (page) => {
      await page.locator('#new-roster-btn').click();
      await page.waitForTimeout(150);
    },
  },
  {
    name: 'roster-editor',
    path: '/roster.html',
    seed: 'rosters',
    setup: async (page) => {
      // Click Edit on the first saved roster card to open the operative
      // editor for that roster (loadout list + Add/Remove controls).
      await page.locator('.saved-roster [data-act="edit"]').first().click();
      await page.waitForTimeout(150);
    },
  },

  // Game flow — each builds on the previous via scripted clicks.
  {
    name: 'game-teams',
    path: '/game.html',
    seed: 'rosters,mapId',
  },
  {
    name: 'game-initiative',
    path: '/game.html',
    seed: 'rosters,mapId',
    setup: clickConfirmedTeams,
  },
  {
    name: 'game-initiative-rolled',
    path: '/game.html',
    seed: 'rosters,mapId',
    setup: async (page) => {
      await clickConfirmedTeams(page);
      await rollInitiativeUntilWinner(page);
    },
  },
  {
    name: 'game-deploy-entry',
    path: '/game.html',
    seed: 'rosters,mapId',
    setup: async (page) => {
      await clickConfirmedTeams(page);
      await rollInitiativeUntilWinner(page);
      // Click whichever "X Deploys First" button is visible (winner-specific).
      const choose = page.locator('#initiative-choose [data-first]:visible').first();
      await choose.click();
      // Phase swap to the board panel takes a tick.
      await page.waitForTimeout(200);
    },
  },

  // Combat scenarios use the window.__kt_test hook in game.js to skip
  // straight to combat with a default unit layout, bypassing the team
  // picker / initiative roll / deploy click sequence.
  {
    name: 'game-combat-entry',
    path: '/game.html',
    seed: 'rosters,mapId',
    setup: async (page) => {
      await page.evaluate(() => window.__kt_test.jumpToCombat({ first: 'A' }));
      await page.waitForTimeout(200);
    },
  },
  {
    name: 'game-combat-activating',
    path: '/game.html',
    seed: 'rosters,mapId',
    setup: async (page) => {
      await page.evaluate(() => {
        window.__kt_test.jumpToCombat({ first: 'A' });
        // Activate Team A's first unit by letter. Letters are auto-assigned
        // from operative names, so 'S' is the Strike Squad sergeant.
        const teamA = window.__kt_test.state().units.filter(u => u.team === 'A');
        window.__kt_test.startActivation(teamA[0].letter);
      });
      await page.waitForTimeout(200);
    },
  },
  {
    name: 'game-combat-shoot-modal',
    path: '/game.html',
    seed: 'rosters,mapId',
    setup: async (page) => {
      await page.evaluate(() => {
        window.__kt_test.jumpToCombat({ first: 'A' });
        const pair = window.__kt_test.findClearShoot();
        if (!pair) throw new Error('no valid shoot pair found on this map');
        window.__kt_test.openShoot(pair.shooter, pair.target);
      });
      await page.waitForTimeout(200);
    },
  },
  {
    name: 'game-combat-shoot-attack-rolled',
    path: '/game.html',
    seed: 'rosters,mapId',
    setup: async (page) => {
      await page.evaluate(() => {
        window.__kt_test.jumpToCombat({ first: 'A' });
        const pair = window.__kt_test.findClearShoot();
        if (!pair) throw new Error('no valid shoot pair found on this map');
        window.__kt_test.openShoot(pair.shooter, pair.target);
        window.__kt_test.advanceShoot('rolledAttack');
        // Modal body scrolls; pin to the bottom so the captured viewport
        // shows the new attack-roll UI rather than the now-static
        // weapon picker at the top.
        document.getElementById('shoot-body').scrollTop = 1e9;
      });
      await page.waitForTimeout(200);
    },
  },
  {
    name: 'game-combat-shoot-resolved',
    path: '/game.html',
    seed: 'rosters,mapId',
    setup: async (page) => {
      await page.evaluate(() => {
        window.__kt_test.jumpToCombat({ first: 'A' });
        const pair = window.__kt_test.findClearShoot();
        if (!pair) throw new Error('no valid shoot pair found on this map');
        window.__kt_test.openShoot(pair.shooter, pair.target);
        window.__kt_test.advanceShoot('resolved');
        document.getElementById('shoot-body').scrollTop = 1e9;
      });
      await page.waitForTimeout(200);
    },
  },
  {
    name: 'game-combat-fight-modal',
    path: '/game.html',
    seed: 'rosters,mapId',
    setup: async (page) => {
      await page.evaluate(() => {
        window.__kt_test.jumpToCombat({ first: 'A' });
        const units = window.__kt_test.state().units;
        const a = units.find(u => u.team === 'A');
        const t = units.find(u => u.team === 'B');
        window.__kt_test.openFight(a.letter, t.letter);
      });
      await page.waitForTimeout(200);
    },
  },
  {
    name: 'game-combat-fight-rolled',
    path: '/game.html',
    seed: 'rosters,mapId',
    setup: async (page) => {
      await page.evaluate(() => {
        window.__kt_test.jumpToCombat({ first: 'A' });
        const units = window.__kt_test.state().units;
        const a = units.find(u => u.team === 'A');
        const t = units.find(u => u.team === 'B');
        window.__kt_test.openFight(a.letter, t.letter);
        window.__kt_test.rollFightDice();
        document.getElementById('fight-body').scrollTop = 1e9;
      });
      await page.waitForTimeout(200);
    },
  },
  {
    name: 'game-over',
    path: '/game.html',
    seed: 'rosters,mapId',
    setup: async (page) => {
      await page.evaluate(() => {
        window.__kt_test.jumpToCombat({ first: 'A' });
        // Blue (A) wipes Red (B) — fires checkVictory(), shows the
        // victory overlay with final VP.
        window.__kt_test.triggerGameOver('B');
      });
      await page.waitForTimeout(200);
    },
  },
  {
    // Map-creator with a real saved map loaded — exercises the layer
    // summary, the canvas with actual pieces, and the loaded-map
    // controls (Save / Export / Delete). Uses tomb-approved-2 from the
    // built-in catalog because it's the densest map and shows the
    // most piece-placement detail.
    name: 'map-creator-loaded',
    path: '/map-creator.html',
    seed: '',
    setup: async (page) => {
      await page.selectOption('#load-map', 'tomb-approved-2');
      await page.waitForTimeout(300);
    },
  },
];

function probePort(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const sock = net.createConnection({ port, host });
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('error', () => resolve(false));
  });
}

async function fetchOk(url) {
  try {
    const res = await fetch(url);
    return res.ok;
  } catch {
    return false;
  }
}

async function startServer() {
  if (await probePort(PORT)) {
    throw new Error(
      `port ${PORT} is already in use — kill the existing process or change PORT in capture.mjs`,
    );
  }
  const proc = spawn('python3', ['-u', '-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  proc.once('exit', (code) => {
    if (code !== null && code !== 0) {
      console.error(`static server exited unexpectedly with code ${code}`);
    }
  });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await fetchOk(`${BASE}/index.html`)) return proc;
    await sleep(100);
  }
  proc.kill();
  throw new Error(`static server did not respond on :${PORT} within 5s`);
}

// Math.random replacement: a deterministic LCG keyed off a fixed seed so dice
// rolls / shuffles in the app are reproducible across runs. Injected before
// any page script executes.
const RANDOM_STUB = `
  (() => {
    let s = 0x9e3779b9 >>> 0;
    Math.random = () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 0x100000000;
    };
  })();
`;

async function captureScenario(ctx, profile, scenario) {
  const page = await ctx.newPage();
  // Chromium background telemetry / safebrowsing fetches surface as
  // ERR_CERT_AUTHORITY_INVALID inside sandboxes that proxy TLS — they have
  // nothing to do with the app under test, so drop them.
  const isEnvNoise = (text) =>
    /ERR_CERT_AUTHORITY_INVALID|ERR_NETWORK_ACCESS_DENIED|net::ERR_BLOCKED_BY_CLIENT/.test(text);
  const errors = [];
  page.on('pageerror', (e) => {
    if (!isEnvNoise(e.message)) errors.push(`pageerror: ${e.message}`);
  });
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    if (!isEnvNoise(text)) errors.push(`console.error: ${text}`);
  });

  await page.addInitScript(RANDOM_STUB);

  const seedFlags = scenario.seed.split(',').map((s) => s.trim()).filter(Boolean);
  if (seedFlags.length) {
    await page.addInitScript(
      ({ rosters, mapId, flags }) => {
        try {
          if (flags.includes('rosters')) {
            localStorage.setItem('kt.rosters.v1', JSON.stringify(rosters));
          }
          if (flags.includes('mapId')) {
            sessionStorage.setItem('kt.mapId', mapId);
          }
        } catch (e) {
          // storage can be unavailable in some headless contexts; the app
          // already handles that, so swallow rather than crash the script.
        }
      },
      { rosters: sampleRosters, mapId: defaultMapId, flags: seedFlags },
    );
  }

  await page.goto(`${BASE}${scenario.path}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);

  if (scenario.setup) {
    try {
      await scenario.setup(page);
    } catch (e) {
      errors.push(`setup failed: ${e.message}`);
    }
    // Let post-setup transitions settle before snapping.
    await page.waitForTimeout(250);
  }

  const base = join(OUT_DIR, `${scenario.name}__${profile.name}`);
  await page.screenshot({ path: `${base}__viewport.png`, fullPage: false });
  await page.screenshot({ path: `${base}__page.png`,     fullPage: true });

  // axe-core a11y audit. We restrict to the kinds of issues that actually
  // matter for a mobile UI review (color contrast, missing labels, target
  // size, focus order). The full WCAG sweep is noisy with rules that don't
  // apply to a single-page app of this style.
  let a11yError = null;
  try {
    const result = await new AxeBuilder({ page })
      .options({
        runOnly: {
          type: 'tag',
          // wcag22aa adds target-size (touch targets ≥ 24×24px) which is the
          // single most relevant a11y rule for a mobile UI review.
          values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'],
        },
      })
      .analyze();
    const summary = {
      url: result.url,
      timestamp: result.timestamp,
      violations: result.violations.map((v) => ({
        id: v.id,
        impact: v.impact,
        help: v.help,
        helpUrl: v.helpUrl,
        nodes: v.nodes.length,
        targets: v.nodes.slice(0, 5).map((n) => n.target.join(' ')),
      })),
    };
    await writeFile(`${base}.a11y.json`, JSON.stringify(summary, null, 2) + '\n');
  } catch (e) {
    a11yError = e.message;
    errors.push(`axe failed: ${e.message}`);
  }

  if (errors.length) {
    await writeFile(`${base}.errors.txt`, errors.join('\n') + '\n');
  }
  await page.close();
  return { base, errors: errors.length, a11yError };
}

async function main() {
  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });

  const server = await startServer();
  let browser;
  try {
    browser = await chromium.launch();
    const summary = [];
    for (const profile of DEVICE_PROFILES) {
      const ctx = await browser.newContext({ ...profile.device });
      for (const scenario of SCENARIOS) {
        const { base, errors } = await captureScenario(ctx, profile, scenario);
        const rel = base.replace(__dirname + '/', '');
        const tag = errors ? `  (${errors} console error${errors === 1 ? '' : 's'})` : '';
        summary.push(`${rel}__{viewport,page}.png${tag}`);
        process.stdout.write(`✓ ${rel}__{viewport,page}.png${tag}\n`);
      }
      await ctx.close();
    }
    await writeFile(join(OUT_DIR, 'INDEX.txt'), summary.join('\n') + '\n');
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

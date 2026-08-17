// Fast single-device capture of the screens changed by the overhaul.
import { chromium, devices } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { sampleRosters, defaultMapId } from './fixtures.mjs';

const PORT = 8161;
const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], {
  cwd: '/home/user/kill-team-mobile', stdio: 'ignore',
});
await sleep(800);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' }).catch(() => chromium.launch());
const ctx = await browser.newContext({ ...devices['iPhone 14'], colorScheme: 'dark' });
await mkdir('screenshots-new', { recursive: true });

const SHOTS = [
  { name: 'teams', setup: async (p) => {} },
  { name: 'teams-selected', setup: async (p) => {
    await p.locator('#roster-list-A .roster-pick-card').first().click();
    await p.locator('#roster-list-B .roster-pick-card.preset').first().click();
    await p.waitForTimeout(150);
  } },
  { name: 'combat-entry', setup: async (p) => {
    await p.evaluate(() => window.__kt_test.jumpToCombat({ first: 'A' }));
    await p.waitForTimeout(250);
  } },
  { name: 'combat-activating', setup: async (p) => {
    await p.evaluate(() => {
      window.__kt_test.jumpToCombat({ first: 'A' });
      const teamA = window.__kt_test.state().units.filter(u => u.team === 'A');
      window.__kt_test.startActivation(teamA[0].letter);
    });
    await p.waitForTimeout(250);
  } },
  { name: 'ploys', setup: async (p) => {
    await p.evaluate(() => window.__kt_test.jumpToCombat({ first: 'A' }));
    await p.waitForTimeout(200);
    await p.locator('#ploys-btn').click();
    await p.waitForTimeout(250);
  } },
  { name: 'fight-armed', setup: async (p) => {
    await p.evaluate(() => {
      window.__kt_test.jumpToCombat({ first: 'A' });
      const units = window.__kt_test.state().units;
      const a = units.find(u => u.team === 'A');
      const t = units.find(u => u.team === 'B');
      window.__kt_test.openFight(a.letter, t.letter);
      window.__kt_test.rollFightDice();
      // arm the first selectable die
      const d = document.querySelector('#fight-body .kt-dice.selectable');
      if (d) d.click();
      document.getElementById('fight-body').scrollTop = 1e9;
    });
    await p.waitForTimeout(250);
  } },
];

for (const shot of SHOTS) {
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  await page.addInitScript(({ rosters, mapId }) => {
    localStorage.setItem('kt.rosters.v1', JSON.stringify(rosters));
    sessionStorage.setItem('kt.mapId', mapId);
  }, { rosters: sampleRosters, mapId: defaultMapId });
  await page.goto(`http://127.0.0.1:${PORT}/game.html`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(300);
  try { await shot.setup(page); } catch (e) { console.log(shot.name, 'setup failed:', e.message); }
  await page.screenshot({ path: `screenshots-new/${shot.name}.png`, fullPage: false });
  await page.screenshot({ path: `screenshots-new/${shot.name}-full.png`, fullPage: true });
  if (errs.length) console.log(shot.name, 'ERRORS:', errs.join(' | '));
  await page.close();
  console.log('✓', shot.name);
}
await browser.close();
server.kill();

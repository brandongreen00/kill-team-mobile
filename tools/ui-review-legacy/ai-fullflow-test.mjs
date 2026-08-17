// Full-UI solo flow: enable AI, confirm teams, roll initiative, deploy the
// human side by clicking the board, and verify the AI deploys itself and
// combat begins.
import { chromium, devices } from 'playwright';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { sampleRosters, defaultMapId } from './fixtures.mjs';

const PORT = 8181;
const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], {
  cwd: '/home/user/kill-team-mobile', stdio: 'ignore',
});
await sleep(800);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' }).catch(() => chromium.launch());
const ctx = await browser.newContext({ ...devices['iPhone 14'] });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.addInitScript(({ rosters, mapId }) => {
  localStorage.setItem('kt.rosters.v1', JSON.stringify(rosters));
  sessionStorage.setItem('kt.mapId', mapId);
}, { rosters: sampleRosters, mapId: defaultMapId });
await page.goto(`http://127.0.0.1:${PORT}/game.html`, { waitUntil: 'networkidle' });

// Pick Blue roster, enable AI for Red (auto-picks Plague Marines preset).
await page.locator('#roster-list-A .roster-pick-card').first().click();
await page.locator('#ai-toggle-B').check();
await sleep(200);
const summaryB = await page.locator('#roster-summary-B').textContent();
console.log('Red summary after AI toggle:', summaryB.trim());
await page.locator('#confirm-teams').click();
await sleep(300);

// Roll initiative until a winner; if the human wins, choose to deploy first.
for (let i = 0; i < 6; i++) {
  const rollVisible = await page.locator('#roll-btn').isVisible();
  if (!rollVisible) break;
  await page.locator('#roll-btn').click();
  await sleep(1200);
  const chooseVisible = await page.locator('#initiative-choose').isVisible();
  if (chooseVisible) {
    const winner = await page.evaluate(() => window.__kt_test.state().initiative.winner);
    console.log('initiative winner:', winner);
    if (winner === 'A') await page.locator('#first-A-btn').click();
    // If B (AI) won, ai.js auto-clicks within a tick.
    await sleep(1500);
    break;
  }
}
const phase1 = await page.evaluate(() => window.__kt_test.state().phase);
console.log('phase after initiative:', phase1);

// Deployment: click legal spots for the human; the AI places its own units.
for (let i = 0; i < 40; i++) {
  const st = await page.evaluate(() => {
    const s = window.__kt_test.state();
    return { phase: s.phase, cur: s.deploy.currentTeam,
             pending: s.deploy.pendingUnit ? s.deploy.pendingUnit.letter : null,
             placedA: s.deploy.placedCount.A, placedB: s.deploy.placedCount.B };
  });
  if (st.phase !== 'deploy') break;
  if (st.cur === 'A' && st.pending) {
    // Place via the test API-adjacent path: find a valid point and commit it.
    await page.evaluate(() => {
      const s = window.__kt_test.state();
      const A = window.__kt_ai_api;
      const u = s.deploy.pendingUnit;
      const zone = window.KT.deployZone(A.mapDef(), 'A');
      outer:
      for (let x = zone.x + 1; x < zone.x + zone.w; x += 0.7) {
        for (let y = zone.y + 1; y < zone.y + zone.h; y += 0.7) {
          if (A.validDeployPoint(u, x, y) && A.tryPlacePending(x, y)) break outer;
        }
      }
    });
  }
  await sleep(500);
}
const final = await page.evaluate(() => {
  const s = window.__kt_test.state();
  return { phase: s.phase, tp: s.combat.turningPoint,
           deployedA: s.units.filter(u => u.team === 'A' && u.deployed).length,
           deployedB: s.units.filter(u => u.team === 'B' && u.deployed).length,
           bFaction: s.rosters.B && s.rosters.B.factionId,
           tacB: s.tacOpChoice.B, aiTeam: s.aiTeam };
});
console.log('final:', JSON.stringify(final));
// Let the AI take its first combat activations.
await sleep(6000);
const combat = await page.evaluate(() => {
  const log = document.getElementById('log')?.textContent || '';
  return log.slice(-400);
});
console.log('combat log tail:', combat.replace(/\s+/g, ' '));
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'NO PAGE ERRORS');
await browser.close();
server.kill();

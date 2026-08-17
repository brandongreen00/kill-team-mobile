// Deterministic Guard-interrupt test: a Blue operative goes on Guard with
// LoS to a Red operative; Red then moves; the interrupt picker must appear
// and the free shot must resolve without spending Red's AP.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { sampleRosters, defaultMapId } from './fixtures.mjs';

const PORT = 8171;
const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], {
  cwd: '/home/user/kill-team-mobile', stdio: 'ignore',
});
await sleep(800);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' }).catch(() => chromium.launch());
const page = await browser.newPage();
page.on('pageerror', e => console.log('PAGEERROR', e.message));
await page.addInitScript(({ rosters, mapId }) => {
  localStorage.setItem('kt.rosters.v1', JSON.stringify(rosters));
  sessionStorage.setItem('kt.mapId', mapId);
}, { rosters: sampleRosters, mapId: defaultMapId });
await page.goto(`http://127.0.0.1:${PORT}/game.html`, { waitUntil: 'networkidle' });

const r1 = await page.evaluate(() => {
  window.__kt_test.jumpToCombat({ first: 'A' });
  const A = window.__kt_ai_api;
  const s = A.state();
  const guard = s.units.find(u => u.team === 'A');
  const mover = s.units.find(u => u.team === 'B');
  // Clear positions with LoS on the open lane (y≈2 row is fairly open).
  guard.x = 9; guard.y = 2;
  mover.x = 14.5; mover.y = 2;
  // Blue activates and goes on Guard.
  window.__kt_test.startActivation(guard.letter);
  const beforeAP = A.activation().ap;
  A.performGuard();
  const afterAP = A.activation().ap;
  A.endActivation();
  return { guard: guard.letter, mover: mover.letter, onGuard: guard.onGuard, apSpent: beforeAP - afterAP };
});
console.log('guard setup:', JSON.stringify(r1));

const r2 = await page.evaluate(() => {
  const A = window.__kt_ai_api;
  const s = A.state();
  const mover = s.units.find(u => u.team === 'B');
  // Red activates and dashes 2" — an action resolves, so the Guard offer
  // should appear.
  s.combat.activeTeam = 'B';
  mover.unitState = 'ready';
  A.startActivation(mover);
  const ok = A.doMove('dash', mover.x - 2, mover.y);
  const picker = document.getElementById('target-picker');
  const visible = picker && picker.style.display !== 'none';
  const text = visible ? picker.textContent : '';
  const guard = s.units.find(u => u.team === 'A');
  return { moved: ok, pickerVisible: visible, pickerText: text.slice(0, 120),
    diag: {
      onGuard: guard.onGuard,
      guardPos: [guard.x, guard.y], moverPos: [mover.x, mover.y],
      cands: A.shootCandidates(guard).map(c => c.target.letter),
      inCR: A.KTR.inEnemyControlRange(guard, s.units),
      actTeam: A.activation() && A.activation().unit.team,
      guardInterrupted: A.activation() && A.activation().guardInterrupted,
    } };
});
console.log('after enemy action:', JSON.stringify(r2));

if (r2.pickerVisible && /Guard/i.test(r2.pickerText)) {
  const r3 = await page.evaluate(() => {
    const A = window.__kt_ai_api;
    const s = A.state();
    const enemyAP = A.activation().ap;
    // Take the interrupt: first row = the guard unit's shoot option.
    document.querySelector('#target-picker .kt-target-row').click();
    // Guard shoot target picker appears → click first target.
    const row2 = document.querySelector('#target-picker .kt-target-row');
    if (row2) row2.click();
    const shoot = s.combat.shoot;
    const free = shoot && shoot.free;
    const step = shoot && shoot.step;
    if (shoot && step !== 'resolved') { window.__kt_test.advanceShoot('resolved'); }
    document.querySelector('#kt-shoot-done')?.click();
    const enemyAPAfter = A.activation() ? A.activation().ap : null;
    const guard = s.units.find(u => u.team === 'A');
    return { free, step, enemyAP, enemyAPAfter, guardStillOn: guard.onGuard,
             hp: s.units.find(u => u.team === 'B').hp };
  });
  console.log('interrupt result:', JSON.stringify(r3));
} else {
  console.log('FAIL: Guard interrupt did not offer');
}
await browser.close();
server.kill();

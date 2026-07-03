// Headless AI soak test: AI (Red) vs a do-nothing human (Blue) from combat
// entry to game end. Reports progress and any page errors.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { sampleRosters, defaultMapId } from './fixtures.mjs';

const PORT = 8151;
const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], {
  cwd: '/home/user/kill-team-mobile', stdio: 'ignore',
});
await sleep(800);

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' }).catch(() => chromium.launch());
const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => {
  if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text());
});

await page.addInitScript(({ rosters, mapId }) => {
  localStorage.setItem('kt.rosters.v1', JSON.stringify(rosters));
  sessionStorage.setItem('kt.mapId', mapId);
}, { rosters: sampleRosters, mapId: defaultMapId });

await page.goto(`http://127.0.0.1:${PORT}/game.html`, { waitUntil: 'networkidle' });

await page.evaluate(() => {
  window.__kt_test.jumpToCombat({ first: 'A' });
  const s = window.__kt_test.state();
  s.aiTeam = 'B';
  window.KT_AI.poke();
  // Scripted "human": whenever it's Blue's turn, activate the first ready
  // operative and immediately end the activation; pass all counteracts.
  const A = window.__kt_ai_api;
  setInterval(() => {
    const st = A.state();
    if (st.phase !== 'combat' || st.combat.over) return;
    if (st.combat.shoot && st.combat.shoot.attacker.team === 'A') { A.commitShoot(); return; }
    if (st.combat.fight && st.combat.fight.attacker.team === 'A') { A.commitFight(); return; }
    if (st.combat.shoot || st.combat.fight) return;
    const picker = document.getElementById('target-picker');
    if (picker && picker.style.display !== 'none') {
      // Decline guard interrupts (tap Cancel = last row).
      const rows = picker.querySelectorAll('.kt-target-row');
      if (rows.length) rows[rows.length - 1].click();
      return;
    }
    if (st.combat.counteract && st.combat.counteract.selecting && st.combat.counteract.team === 'A') {
      A.passCounteract(); return;
    }
    const act = A.activation();
    if (act && act.unit.team === 'A') { A.endActivation(); return; }
    if (!act && A.activeTeam() === 'A' && A.readyUnits('A').length) {
      A.startActivation(A.readyUnits('A')[0]);
    }
  }, 200);
});

// Watch the game progress for up to 3 minutes.
let last = '';
for (let i = 0; i < 90; i++) {
  await sleep(2000);
  const snap = await page.evaluate(() => {
    const s = window.__kt_test.state();
    const act = window.__kt_ai_api.activation();
    let plans = null;
    try { plans = act && act.unit.team === 'B' ? window.KT_AI.plans() : null; } catch (e) { plans = 'ERR ' + e.message; }
    return {
      actUnit: act ? act.unit.letter + '/' + act.unit.team + ' ap' + act.ap : null,
      plans,
      tp: s.combat.turningPoint, phase: s.phase, over: s.combat.over,
      aAlive: s.units.filter(u => u.team === 'A' && u.alive).length,
      bAlive: s.units.filter(u => u.team === 'B' && u.alive).length,
      score: s.score, cp: s.combat.cp,
      logTail: (document.getElementById('log')?.textContent || '').slice(-300),
    };
  });
  if (snap.plans) console.log('  plans for', snap.actUnit, JSON.stringify(snap.plans));
  const line = `TP${snap.tp} phase=${snap.phase} A:${snap.aAlive} B:${snap.bAlive} VP A:${snap.score.killOp.A + snap.score.critOp.A + snap.score.tacOp.A} B:${snap.score.killOp.B + snap.score.critOp.B + snap.score.tacOp.B}`;
  if (line !== last) { console.log(line); last = line; }
  if (snap.phase === 'over' || snap.over) {
    console.log('GAME OVER. score:', JSON.stringify(snap.score));
    const detail = await page.evaluate(() => {
      const s = window.__kt_test.state();
      return {
        critOp: s.combat.ops && s.combat.ops.critOp,
        objState: s.combat.ops && s.combat.ops.objState,
        objectives: window.KT.getMap('tomb-approved-2').objectives,
        bUnits: s.units.filter(u => u.team === 'B').map(u => ({ l: u.letter, x: Math.round(u.x*10)/10, y: Math.round(u.y*10)/10, alive: u.alive, order: u.order })),
        fullLog: (document.getElementById('log')?.textContent || ''),
      };
    });
    console.log('critOp:', detail.critOp, JSON.stringify(detail.objState));
    console.log('objectives:', JSON.stringify(detail.objectives));
    console.log('B units:', JSON.stringify(detail.bUnits));
    const moves = detail.fullLog.match(/[A-Z][0-9]? (repositions|dashes|charges|falls back)[^.]*\./g) || [];
    console.log('move log entries:', moves.length, moves.slice(0, 8));
    break;
  }
}

console.log(errors.length ? 'ERRORS:\n' + errors.slice(0, 20).join('\n') : 'NO PAGE ERRORS');
await browser.close();
server.kill();

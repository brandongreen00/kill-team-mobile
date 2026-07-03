import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { sampleRosters, defaultMapId } from './fixtures.mjs';

const PORT = 8152;
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

const out = await page.evaluate(() => {
  window.__kt_test.jumpToCombat({ first: 'B' });
  const A = window.__kt_ai_api;
  const res = [];
  for (const u of A.state().units.filter(x => x.team === 'B')) {
    A.state().combat.activeTeam = 'B';
    u.unitState = 'ready';
    A.startActivation(u);
    const act = A.activation();
    let plans;
    try { plans = window.KT_AI.plans(); } catch (e) { plans = 'ERR ' + e.message; }
    res.push({ letter: u.letter, pos: [Math.round(u.x*10)/10, Math.round(u.y*10)/10], ap: act && act.ap, plans });
    A.endActivation();
  }
  return res;
});
console.log(JSON.stringify(out, null, 1));
await browser.close();
server.kill();

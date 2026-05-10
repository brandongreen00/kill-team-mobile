// Headless mobile-viewport screenshot capture for every page in the app.
//
// Usage:
//   cd tools/ui-review
//   npm install
//   npm run install-browser   # once, downloads chromium for playwright
//   npm run capture           # writes screenshots/<scenario>__<device>.png
//
// What it does:
//   1. Boots a Python static server pointed at the repo root.
//   2. For each (device profile × scenario), opens a fresh Playwright
//      browser context with the device's mobile viewport / DPR / UA / touch.
//   3. Optionally seeds localStorage and sessionStorage *before* page scripts
//      run, so that screens requiring saved rosters or a chosen map render
//      with realistic content rather than empty states.
//   4. Captures a full-page PNG and, when present, writes a sidecar
//      <name>.errors.txt with any pageerror / console.error output.
//
// Out of scope for this baseline pass: clicking through the team picker into
// deploy / combat (those phases need scripted interactions — add scenarios
// here once we want to capture them).

import { chromium, devices } from 'playwright';
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

// `seed` is a comma-separated set of fixture flags applied via addInitScript:
//   'rosters' → localStorage['kt.rosters.v1'] = sampleRosters
//   'mapId'   → sessionStorage['kt.mapId']    = defaultMapId
const SCENARIOS = [
  { name: 'index',             path: '/index.html',        seed: '' },
  { name: 'maps',              path: '/maps.html',         seed: '' },
  { name: 'map-creator',       path: '/map-creator.html',  seed: '' },
  { name: 'roster-empty',      path: '/roster.html',       seed: '' },
  { name: 'roster-populated',  path: '/roster.html',       seed: 'rosters' },
  { name: 'game-teams',        path: '/game.html',         seed: 'rosters,mapId' },
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

async function captureScenario(ctx, profile, scenario) {
  const page = await ctx.newPage();
  const errors = [];
  // Chromium background telemetry / safebrowsing fetches surface as
  // ERR_CERT_AUTHORITY_INVALID inside sandboxes that proxy TLS — they have
  // nothing to do with the app under test, so drop them.
  const isEnvNoise = (text) =>
    /ERR_CERT_AUTHORITY_INVALID|ERR_NETWORK_ACCESS_DENIED|net::ERR_BLOCKED_BY_CLIENT/.test(text);
  page.on('pageerror', (e) => {
    if (!isEnvNoise(e.message)) errors.push(`pageerror: ${e.message}`);
  });
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    if (!isEnvNoise(text)) errors.push(`console.error: ${text}`);
  });

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
  // Give canvas-heavy pages a beat to finish their first paint.
  await page.waitForTimeout(400);

  const file = join(OUT_DIR, `${scenario.name}__${profile.name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  if (errors.length) {
    await writeFile(file.replace(/\.png$/, '.errors.txt'), errors.join('\n') + '\n');
  }
  await page.close();
  return { file, errors: errors.length };
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
        const { file, errors } = await captureScenario(ctx, profile, scenario);
        const rel = file.replace(__dirname + '/', '');
        summary.push(`${rel}${errors ? `  (${errors} console error${errors === 1 ? '' : 's'})` : ''}`);
        process.stdout.write(`✓ ${rel}\n`);
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

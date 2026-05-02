// Playwright config for kill-team-mobile.
//
// We serve the repo root with `python3 -m http.server` (no Node deps required
// for the static site itself) and run the suite headless against Chromium.
// The default phone-portrait viewport mirrors how the app is actually used.

const { defineConfig, devices } = require('@playwright/test');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.KT_E2E_PORT || 4173);
const BASE_URL = `http://127.0.0.1:${PORT}`;

module.exports = defineConfig({
  testDir: __dirname,
  testMatch: '**/*.spec.js',
  outputDir: path.join(__dirname, '.results'),
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 5000,
  },
  webServer: {
    command: `python3 -m http.server ${PORT} --bind 127.0.0.1`,
    cwd: REPO_ROOT,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    stdout: 'ignore',
    stderr: 'pipe',
    timeout: 30_000,
  },
  projects: [
    {
      name: 'mobile-portrait',
      use: { ...devices['Pixel 7'] },
    },
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});

import { defineConfig, devices } from '@playwright/test';

/** Phone-first, but every flow must work on a desktop too. */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4173/kill-team-mobile/',
    trace: 'retain-on-failure',
    // This environment ships Chromium at a fixed path; a pinned @playwright/test version
    // would otherwise try to download its own.
    // `--no-sandbox` only when we point at that Chromium, i.e. inside the root container.
    launchOptions: process.env['PW_CHROMIUM']
      ? { executablePath: process.env['PW_CHROMIUM'], args: ['--no-sandbox'] }
      : {},
  },
  webServer: {
    command: 'pnpm build && pnpm preview --port 4173 --strictPort',
    url: 'http://localhost:4173/kill-team-mobile/',
    reuseExistingServer: !process.env['CI'],
    timeout: 180_000,
  },
  // Device emulation only — every project runs on Chromium so a single browser binary is
  // enough (WebKit/Firefox are not installed in the container that runs these).
  projects: [
    { name: 'iphone-se', use: { ...devices['iPhone SE'], browserName: 'chromium' } },
    { name: 'pixel-7', use: { ...devices['Pixel 7'], browserName: 'chromium' } },
    // A phone held sideways is a different layout, not a narrower one: the command sheet
    // docks to the side, because a bottom sheet on a 390px-tall screen leaves no killzone.
    { name: 'phone-landscape', use: { ...devices['iPhone 13 landscape'], browserName: 'chromium' } },
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1440, height: 900 } } },
  ],
});

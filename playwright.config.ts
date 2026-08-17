import { defineConfig, devices } from '@playwright/test';

/** Phone-first, but every flow must work on a desktop too. */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  reporter: [['list']],
  use: { baseURL: 'http://localhost:4173/kill-team-mobile/', trace: 'retain-on-failure' },
  webServer: {
    command: 'pnpm build && pnpm preview --port 4173 --strictPort',
    url: 'http://localhost:4173/kill-team-mobile/',
    reuseExistingServer: !process.env['CI'],
    timeout: 180_000,
  },
  projects: [
    { name: 'iphone-se', use: { ...devices['iPhone SE'] } },
    { name: 'pixel-7', use: { ...devices['Pixel 7'] } },
    { name: 'desktop', use: { viewport: { width: 1440, height: 900 } } },
  ],
});

// End-to-end tests for the game runtime: team picker → initiative → deploy.
// Rosters and the chosen map are pre-seeded into storage so we can drive the
// full setup flow without going through the roster builder UI.

const { test, expect } = require('@playwright/test');
const { seedGame, seedInitiativeWinner, KASRKIN_ROSTER_A } = require('./fixtures/seed');

test.describe('game setup flow', () => {
  test('team picker lists the seeded roster on both sides', async ({ page }) => {
    await seedGame(page);
    await page.goto('/game.html');
    await expect(page.locator('#phase-teams')).toBeVisible();
    const aCards = page.locator('#roster-list-A .roster-pick-card');
    const bCards = page.locator('#roster-list-B .roster-pick-card');
    await expect(aCards.first()).toContainText(KASRKIN_ROSTER_A.name);
    await expect(bCards.first()).toContainText(KASRKIN_ROSTER_A.name);
    // Both rosters are listed on each side — players must explicitly pick.
    await expect(page.locator('#confirm-teams')).toBeDisabled();
  });

  test('selecting a roster on each side enables Confirm Teams', async ({ page }) => {
    await seedGame(page);
    await page.goto('/game.html');
    await page.locator('#roster-list-A .roster-pick-card').first().click();
    await expect(page.locator('#confirm-teams')).toBeDisabled(); // still need B
    await page.locator('#roster-list-B .roster-pick-card').nth(1).click();
    await expect(page.locator('#confirm-teams')).toBeEnabled();
    // Each side's summary line reflects the picked roster.
    await expect(page.locator('#roster-summary-A')).toContainText(/operatives/);
    await expect(page.locator('#roster-summary-B')).toContainText(/operatives/);
  });

  test('Confirm Teams transitions to the initiative phase', async ({ page }) => {
    await seedGame(page);
    await page.goto('/game.html');
    await page.locator('#roster-list-A .roster-pick-card').first().click();
    await page.locator('#roster-list-B .roster-pick-card').nth(1).click();
    await page.locator('#confirm-teams').click();
    await expect(page.locator('#phase-teams')).toBeHidden();
    await expect(page.locator('#phase-initiative')).toBeVisible();
    await expect(page.locator('#roll-btn')).toBeVisible();
  });

  test('rolling initiative surfaces the deploy-first chooser', async ({ page }) => {
    await seedGame(page);
    await seedInitiativeWinner(page, 'A');
    await page.goto('/game.html');
    await page.locator('#roster-list-A .roster-pick-card').first().click();
    await page.locator('#roster-list-B .roster-pick-card').nth(1).click();
    await page.locator('#confirm-teams').click();
    await page.locator('#roll-btn').click();
    await expect(page.locator('#initiative-result')).toContainText(/wins initiative/i, { timeout: 3000 });
    await expect(page.locator('#initiative-choose')).toBeVisible();
    await expect(page.locator('#first-A-btn')).toBeVisible();
    await expect(page.locator('#first-B-btn')).toBeVisible();
  });

  test('picking who deploys first lands on the deployment phase', async ({ page }) => {
    await seedGame(page);
    await seedInitiativeWinner(page, 'A');
    await page.goto('/game.html');
    await page.locator('#roster-list-A .roster-pick-card').first().click();
    await page.locator('#roster-list-B .roster-pick-card').nth(1).click();
    await page.locator('#confirm-teams').click();
    await page.locator('#roll-btn').click();
    await expect(page.locator('#initiative-choose')).toBeVisible({ timeout: 3000 });
    await page.locator('#first-A-btn').click();
    await expect(page.locator('#phase-board')).toBeVisible();
    await expect(page.locator('#phase-chip')).toHaveText(/Deployment/i);
    await expect(page.locator('canvas#board')).toBeVisible();
  });
});

test.describe('game.html with no rosters in storage', () => {
  test('renders the team picker with an empty-state hint on each side', async ({ page }) => {
    await page.addInitScript(() => {
      try {
        localStorage.removeItem('kt.rosters.v1');
        sessionStorage.setItem('kt.mapId', 'tomb-1');
      } catch (e) {}
    });
    await page.goto('/game.html');
    await expect(page.locator('#roster-list-A')).toContainText(/No rosters saved/i);
    await expect(page.locator('#roster-list-B')).toContainText(/No rosters saved/i);
    await expect(page.locator('#confirm-teams')).toBeDisabled();
  });
});

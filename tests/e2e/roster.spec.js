// Roster builder — view transitions, faction selection, and persistence to
// localStorage['kt.rosters.v1']. We don't drive the full operative-pick UI
// here; the game.spec uses a pre-seeded roster fixture for that.

const { test, expect } = require('@playwright/test');

test.describe('roster builder', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      try { localStorage.removeItem('kt.rosters.v1'); } catch (e) {}
    });
  });

  test('starts on the index view with no rosters', async ({ page }) => {
    await page.goto('/roster.html');
    await expect(page.locator('#view-index')).toBeVisible();
    await expect(page.locator('#view-pick-faction')).toBeHidden();
    await expect(page.locator('#view-editor')).toBeHidden();
    await expect(page.locator('#roster-list')).toContainText(/No rosters yet/i);
  });

  test('"+ New Roster" advances to the faction picker', async ({ page }) => {
    await page.goto('/roster.html');
    await page.locator('#new-roster-btn').click();
    await expect(page.locator('#view-pick-faction')).toBeVisible();
    // At least a handful of faction cards should appear.
    const cards = page.locator('#faction-grid .faction-card');
    await expect.poll(async () => cards.count(), { timeout: 3000 }).toBeGreaterThanOrEqual(3);
  });

  test('picking a faction lands in the editor with that faction labelled', async ({ page }) => {
    await page.goto('/roster.html');
    await page.locator('#new-roster-btn').click();
    const firstFaction = page.locator('#faction-grid .faction-card').first();
    const factionName = (await firstFaction.locator('.faction-name').textContent()) || '';
    await firstFaction.click();
    await expect(page.locator('#view-editor')).toBeVisible();
    await expect(page.locator('#editor-faction-label')).toContainText(factionName.trim());
  });

  test('a roster pre-seeded into localStorage shows up on the index', async ({ page }) => {
    await page.addInitScript(() => {
      const sample = [{
        id: 'r_seed_test',
        name: 'Seeded Strike Force',
        factionId: 'space-marines',
        picks: [],
      }];
      localStorage.setItem('kt.rosters.v1', JSON.stringify(sample));
    });
    await page.goto('/roster.html');
    await expect(page.locator('#roster-list')).toContainText('Seeded Strike Force');
  });
});

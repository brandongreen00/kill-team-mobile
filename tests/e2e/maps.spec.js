// Map picker — every built-in map renders, selection is single-card,
// "Deploy Kill Team" is gated until a card is selected, and clicking it
// stamps the chosen id into sessionStorage.

const { test, expect } = require('@playwright/test');

test.describe('map picker', () => {
  test('renders one card per built-in map and gates Deploy until one is picked', async ({ page }) => {
    await page.goto('/maps.html');
    const cards = page.locator('.map-card');
    // Built-in TOMB_MAPS in maps-data.js currently defines 7 maps (tomb-1..6
    // plus tomb-approved-2). We assert at least 5 to allow content additions.
    await expect.poll(async () => cards.count(), { timeout: 5000 }).toBeGreaterThanOrEqual(5);

    const deploy = page.locator('#deploy-btn');
    await expect(deploy).toBeDisabled();

    await cards.first().click();
    await expect(deploy).toBeEnabled();
    await expect(cards.first()).toHaveClass(/selected/);

    // Clicking a different card moves the selection.
    await cards.nth(1).click();
    await expect(cards.first()).not.toHaveClass(/selected/);
    await expect(cards.nth(1)).toHaveClass(/selected/);
  });

  test('Deploy Kill Team writes kt.mapId to sessionStorage and routes to game.html', async ({ page }) => {
    await page.goto('/maps.html');
    const firstCard = page.locator('.map-card').first();
    await firstCard.click();
    const expectedId = await firstCard.getAttribute('data-id');
    await page.locator('#deploy-btn').click();
    await expect(page).toHaveURL(/game\.html$/);
    const stored = await page.evaluate(() => sessionStorage.getItem('kt.mapId'));
    expect(stored).toBe(expectedId);
  });
});

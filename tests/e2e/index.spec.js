// Smoke-tests for the main menu — links, page title, and that the rest of
// the site is reachable from here.

const { test, expect } = require('@playwright/test');

test.describe('main menu', () => {
  test('renders the title and three primary nav buttons', async ({ page }) => {
    await page.goto('/index.html');
    await expect(page).toHaveTitle(/Kill Team/i);
    await expect(page.getByRole('heading', { name: 'Kill Team' })).toBeVisible();
    await expect(page.getByRole('link', { name: /Begin Engagement/i })).toBeVisible();
    await expect(page.getByRole('link', { name: /^Roster$/i })).toBeVisible();
    await expect(page.getByRole('link', { name: /Map Creator/i })).toBeVisible();
  });

  test('"Begin Engagement" routes to the map picker', async ({ page }) => {
    await page.goto('/index.html');
    await page.getByRole('link', { name: /Begin Engagement/i }).click();
    await expect(page).toHaveURL(/maps\.html$/);
    await expect(page.getByRole('heading', { name: /Select Battlefield/i })).toBeVisible();
  });

  test('Roster link routes to the datavault', async ({ page }) => {
    await page.goto('/index.html');
    await page.getByRole('link', { name: /^Roster$/i }).click();
    await expect(page).toHaveURL(/roster\.html$/);
  });

  test('Map Creator link routes to the editor', async ({ page }) => {
    await page.goto('/index.html');
    await page.getByRole('link', { name: /Map Creator/i }).first().click();
    await expect(page).toHaveURL(/map-creator\.html$/);
  });
});

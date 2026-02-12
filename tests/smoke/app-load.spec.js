const { test, expect } = require('@playwright/test');

test('smoke: app loads', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('body')).toBeVisible();
});

const { test, expect } = require('@playwright/test');

test('smoke: app loads with no critical errors', async ({ page }) => {
  const consoleErrors = [];
  const serverErrors = [];

  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  page.on('response', (res) => {
    if (res.status() >= 500) serverErrors.push(`${res.status()} ${res.url()}`);
  });

  await page.goto('/');
  await expect(page.locator('body')).toBeVisible();
  await expect(page.locator('body')).not.toContainText('NaN');

  expect(consoleErrors).toEqual([]);
  expect(serverErrors).toEqual([]);
});

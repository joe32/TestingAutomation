const { test, expect } = require('@playwright/test');

function logStep(message) {
  const timestamp = new Date().toISOString();
  console.log(`[smoke][${timestamp}] ${message}`);
}

test('smoke: app loads with no critical errors', async ({ page }) => {
  const consoleErrors = [];
  const serverErrors = [];

  logStep('Starting smoke test');

  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  page.on('response', (res) => {
    if (res.status() >= 500) serverErrors.push(`${res.status()} ${res.url()}`);
  });

  logStep('Opening app root');
  await page.goto('/');
  logStep(`Current URL: ${page.url()}`);

  logStep('Running basic render checks');
  await expect(page.locator('body')).toBeVisible();
  await expect(page.locator('body')).not.toContainText('NaN');

  logStep('Validating no critical console/server errors');
  expect(consoleErrors).toEqual([]);
  expect(serverErrors).toEqual([]);

  logStep('Smoke test completed successfully');
});

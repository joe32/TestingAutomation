const { test, expect } = require('@playwright/test');

function logStep(message) {
  const timestamp = new Date().toISOString();
  console.log(`[smoke][${timestamp}] ${message}`);
}

function emitE2EEvent(payload) {
  console.log(`[E2E_EVENT] ${JSON.stringify(payload)}`);
}

test.afterEach(async ({}, testInfo) => {
  const testId = `${testInfo.file} :: ${testInfo.title}`;
  emitE2EEvent({
    type: 'test_end',
    test: testId,
    status: testInfo.status,
    durationMs: testInfo.duration,
  });
});

test('smoke: app loads with no critical errors', async ({ page }) => {
  const consoleErrors = [];
  const serverErrors = [];
  const testInfo = test.info();
  const testId = `${testInfo.file} :: ${testInfo.title}`;

  emitE2EEvent({ type: 'test_start', test: testId });

  logStep('Starting smoke test');
  emitE2EEvent({ type: 'step', test: testId, detail: 'Starting smoke test' });

  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  page.on('response', (res) => {
    if (res.status() >= 500) serverErrors.push(`${res.status()} ${res.url()}`);
  });

  logStep('Opening app root');
  emitE2EEvent({ type: 'step', test: testId, detail: 'Opening app root' });
  await page.goto('/');
  logStep(`Current URL: ${page.url()}`);
  emitE2EEvent({ type: 'step', test: testId, detail: `Current URL ${page.url()}` });

  logStep('Running basic render checks');
  emitE2EEvent({ type: 'step', test: testId, detail: 'Running basic render checks' });
  await expect(page.locator('body')).toBeVisible();
  await expect(page.locator('body')).not.toContainText('NaN');

  logStep('Validating no critical console/server errors');
  emitE2EEvent({ type: 'step', test: testId, detail: 'Validating critical console/server errors' });
  expect(consoleErrors).toEqual([]);
  expect(serverErrors).toEqual([]);

  logStep('Smoke test completed successfully');
  emitE2EEvent({ type: 'step', test: testId, detail: 'Smoke test completed successfully' });
});

const { test, expect } = require('../shared-fixture');
// @runner-name: Smoke
// @runner-children: smoke.core=Check app loads with no critical errors

function logStep(message) {
  const timestamp = new Date().toISOString();
  console.log(`[smoke][${timestamp}] ${message}`);
}

function emitE2EEvent(payload) {
  console.log(`[E2E_EVENT] ${JSON.stringify(payload)}`);
}

function selectedTasks() {
  const raw = process.env.RUNNER_TASKS || '';
  const items = raw.split(',').map((x) => x.trim()).filter(Boolean);
  return items.length ? new Set(items) : null;
}

test.afterEach(async ({}, testInfo) => {
  const testId = `${testInfo.file} :: ${testInfo.title}`;
  const errorText = testInfo.error
    ? `${testInfo.error.message || ''}\n${testInfo.error.stack || ''}`.trim()
    : null;
  emitE2EEvent({
    type: 'test_end',
    test: testId,
    status: testInfo.status,
    durationMs: testInfo.duration,
    error: errorText,
  });
});

test('smoke: app loads with no critical errors', async ({ sharedPage: page }) => {
  const tasks = selectedTasks();
  if (tasks && !tasks.has('smoke.core')) {
    test.skip(true, 'smoke.core not selected for this run');
  }

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

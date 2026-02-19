const { test, expect } = require('../shared-fixture');
// @runner-name: Chats
// @runner-children: chats.load=Check chats loads;chats.tabs=Switch chats tabs (Whatsapp, Web, All);chats.filters90=Reset filters and set Period to Last 90 days;chats.messageActions=Open top chat and validate transcript/phone actions
// Regression spec ordering:
// 10-*.spec.js runs before 20-*.spec.js, then 30-*.spec.js, etc.
// To add the next flow, copy this file and name it like 30-<feature>.spec.js.

function logStep(message) {
  const timestamp = new Date().toISOString();
  console.log(`[chats-tabs][${timestamp}] ${message}`);
}

function emitE2EEvent(payload) {
  console.log(`[E2E_EVENT] ${JSON.stringify(payload)}`);
}

function selectedTasks() {
  const raw = process.env.RUNNER_TASKS || '';
  const items = raw.split(',').map((x) => x.trim()).filter(Boolean);
  return items.length ? new Set(items) : null;
}

function shouldRunTask(tasks, taskId) {
  return !tasks || tasks.has(taskId);
}

function getTenantBasePath(currentUrl) {
  const url = new URL(currentUrl);
  const parts = url.pathname.split('/').filter(Boolean);
  if (!parts.length) {
    throw new Error(`Could not detect tenant slug from URL: ${currentUrl}`);
  }
  return `/${parts[0]}`;
}

async function clickChatsTab(page, label) {
  const tabLink = page.getByRole('link', { name: label, exact: true });
  if (await tabLink.count()) {
    await tabLink.first().click();
    return;
  }

  const tabButton = page.getByRole('button', { name: label, exact: true });
  if (await tabButton.count()) {
    await tabButton.first().click();
    return;
  }

  const textFallback = page.getByText(label, { exact: true });
  if (await textFallback.count()) {
    await textFallback.first().click();
    return;
  }

  throw new Error(`Could not find Chats tab "${label}"`);
}

async function assertChatsPageLoaded(page, label) {
  await expect(page.locator('body')).toBeVisible();
  await expect(page.locator('body')).not.toContainText(/not found/i);
  await expect(page.getByRole('heading', { name: 'Chats', exact: true }).first()).toBeVisible();
  await expect(page).toHaveURL(/\/[^/]+\/chats/);
  // Keep this broad to avoid strict-mode collisions with repeated "Chats" text in sidebar/breadcrumb/header.
  const tabLabelLocator = page.getByText(label, { exact: true });
  await expect(tabLabelLocator.first()).toBeVisible();
}

async function waitForTabUrlState(page, tabLabel) {
  if (tabLabel === 'All') {
    await page
      .waitForFunction(() => {
        const u = new URL(window.location.href);
        const activeTab = u.searchParams.get('activeTab');
        return !activeTab || activeTab.toLowerCase() === 'all';
      }, { timeout: 15000 })
      .catch(() => {});
    return;
  }

  await page.waitForFunction((expected) => {
    const u = new URL(window.location.href);
    const activeTab = u.searchParams.get('activeTab');
    return Boolean(activeTab) && activeTab.toLowerCase() === expected.toLowerCase();
  }, tabLabel, { timeout: 15000 });
}

async function openChatsFilters(page) {
  const candidates = [
    page.getByRole('button', { name: /filters?/i }).first(),
    page.locator('[aria-label*="filter" i]').first(),
    page.locator('[title*="filter" i]').first(),
    page.locator('button').filter({ has: page.locator('svg') }).nth(2),
  ];

  for (const locator of candidates) {
    try {
      if (await locator.count()) {
        await locator.click({ timeout: 3000 });
        if (await page.getByText('Filters', { exact: true }).count()) {
          await expect(page.getByText('Filters', { exact: true }).first()).toBeVisible({ timeout: 5000 });
          return;
        }
      }
    } catch {
      // try next candidate
    }
  }

  throw new Error('Could not open Chats filters menu');
}

async function setPeriodToLast90Days(page) {
  // Try native Playwright select first when underlying <select> exists.
  const periodSelect = page.locator('select[name*="period"], select[name*="date_range"], select[id*="period"]').first();
  if (await periodSelect.count()) {
    await periodSelect.selectOption({ label: 'Last 90 days' }).catch(async () => {
      await periodSelect.selectOption({ value: 'last_90' });
    });
    return;
  }

  // If UI uses a custom combobox / native popup, drive it through keyboard.
  const periodControl = page.getByRole('combobox', { name: /period/i }).first();
  await expect(periodControl).toBeVisible();
  await periodControl.click();

  // Starting value is usually Last 7 days; two downs reaches Last 90 days.
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');

  // Verify visible value switched before moving on.
  await expect(periodControl).toContainText('Last 90 days');
}

async function openFirstChatRow(page) {
  const timeoutMs = 20000;
  const start = Date.now();

  const rowCandidates = [
    page.locator('table tbody tr'),
    page.locator('table tr').filter({ has: page.locator('td') }),
    page.locator('[role="row"]').filter({ has: page.locator('[role="cell"]') }),
  ];

  // Wait for at least one visible row to exist (data tables can render async after filters apply).
  while (Date.now() - start < timeoutMs) {
    for (const rows of rowCandidates) {
      const count = await rows.count();
      if (count > 0) {
        const firstRow = rows.first();
        if (await firstRow.isVisible().catch(() => false)) {
          const detailsLink = firstRow
            .locator('a[href*="/chats/"]')
            .filter({ hasNot: page.locator('[href*="?"]') })
            .first();

          if (await detailsLink.count()) {
            await detailsLink.click();
            return;
          }

          const firstRowLink = firstRow.getByRole('link').first();
          if (await firstRowLink.count()) {
            await firstRowLink.click();
            return;
          }

          await firstRow.click();
          return;
        }
      }
    }
    await page.waitForTimeout(500);
  }

  throw new Error('No visible chat rows found to open after waiting 20s.');
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

test.describe('chats tabs', () => {
  test('load /chats and switch Whatsapp -> Web -> All', async ({ sharedPage: page }) => {
    test.setTimeout(0);
    const tasks = selectedTasks();
    const runChatsLoad = shouldRunTask(tasks, 'chats.load');
    const runChatsTabs = shouldRunTask(tasks, 'chats.tabs');
    const runChatsFilters90 = shouldRunTask(tasks, 'chats.filters90');
    const runChatsMessageActions = shouldRunTask(tasks, 'chats.messageActions');
    if (!runChatsLoad && !runChatsTabs && !runChatsFilters90 && !runChatsMessageActions) {
      test.skip(true, 'No chats tasks selected for this run');
    }

    const testInfo = test.info();
    const testId = `${testInfo.file} :: ${testInfo.title}`;
    emitE2EEvent({ type: 'test_start', test: testId });

    let currentUrl = page.url();
    logStep(`Starting chats test from current URL: ${currentUrl}`);
    emitE2EEvent({ type: 'step', test: testId, detail: `Starting from current URL ${currentUrl}` });

    // Reuse existing session/tenant from previous test when available.
    if (!currentUrl || currentUrl === 'about:blank') {
      logStep('No current app URL, opening app root');
      emitE2EEvent({ type: 'step', test: testId, detail: 'No current app URL, opening app root' });
      await page.goto('/');
      currentUrl = page.url();
    }

    if (currentUrl.includes('/login')) {
      logStep('Login page detected. Waiting for human login...');
      emitE2EEvent({ type: 'step', test: testId, detail: 'Login page detected, waiting for human login' });
      await page.waitForURL((url) => !url.pathname.includes('/login'), {
        timeout: 0,
      });
      currentUrl = page.url();
      logStep(`Login completed. URL is now: ${currentUrl}`);
      emitE2EEvent({ type: 'step', test: testId, detail: `Login complete, URL ${currentUrl}` });
    }

    const tenantBasePath = getTenantBasePath(currentUrl);
    const chatsPath = `${tenantBasePath}/chats`;
    logStep(`Navigating to chats page: ${chatsPath}`);
    emitE2EEvent({ type: 'step', test: testId, detail: `Navigating to ${chatsPath}` });
    await page.goto(chatsPath, { waitUntil: 'domcontentloaded' });

    if (runChatsLoad) {
      emitE2EEvent({ type: 'subtest_start', test: testId, subtestId: 'chats.load', subtestName: 'Check chats loads' });
      try {
        await assertChatsPageLoaded(page, 'Chats');
        await expect(page).toHaveURL(/\/[^/]+\/chats/);
        logStep('Chats page loaded');
        emitE2EEvent({ type: 'step', test: testId, detail: 'Chats page loaded' });
        emitE2EEvent({ type: 'subtest_end', test: testId, subtestId: 'chats.load', status: 'passed' });
      } catch (err) {
        emitE2EEvent({ type: 'subtest_end', test: testId, subtestId: 'chats.load', status: 'failed', error: String(err && err.stack ? err.stack : err) });
        throw err;
      }
    }

    if (runChatsTabs) {
      emitE2EEvent({ type: 'subtest_start', test: testId, subtestId: 'chats.tabs', subtestName: 'Switch chats tabs (Whatsapp, Web, All)' });
      try {
        const tabSequence = ['Whatsapp', 'Web', 'All'];
        for (const tabLabel of tabSequence) {
          logStep(`Switching to tab: ${tabLabel}`);
          emitE2EEvent({ type: 'step', test: testId, detail: `Switching tab to ${tabLabel}` });

          await clickChatsTab(page, tabLabel);
          await waitForTabUrlState(page, tabLabel);
          await assertChatsPageLoaded(page, tabLabel);
          await page.waitForTimeout(800);

          logStep(`Tab loaded successfully: ${tabLabel}`);
          emitE2EEvent({ type: 'step', test: testId, detail: `Tab loaded successfully: ${tabLabel}` });
        }
        emitE2EEvent({ type: 'subtest_end', test: testId, subtestId: 'chats.tabs', status: 'passed' });
      } catch (err) {
        emitE2EEvent({ type: 'subtest_end', test: testId, subtestId: 'chats.tabs', status: 'failed', error: String(err && err.stack ? err.stack : err) });
        throw err;
      }
    }

    if (runChatsFilters90) {
      emitE2EEvent({
        type: 'subtest_start',
        test: testId,
        subtestId: 'chats.filters90',
        subtestName: 'Reset filters and set Period to Last 90 days',
      });
      try {
        logStep('Opening chats filters menu');
        emitE2EEvent({ type: 'step', test: testId, detail: 'Opening chats filters menu' });
        await openChatsFilters(page);

        logStep('Resetting filters');
        emitE2EEvent({ type: 'step', test: testId, detail: 'Resetting filters' });
        await page.getByText('Reset', { exact: true }).first().click();
        await page.waitForTimeout(600);
        const beforeUrl = page.url();

        logStep('Setting Period to Last 90 days');
        emitE2EEvent({ type: 'step', test: testId, detail: 'Setting Period to Last 90 days' });
        await setPeriodToLast90Days(page);

        await page.waitForURL(/tableFilters\[date_range\]\[period\]=last_90/i, { timeout: 15000 });
        const afterUrl = page.url();
        expect(
          afterUrl,
          `Period change did not take effect. Before=${beforeUrl} After=${afterUrl}`
        ).not.toBe(beforeUrl);

        logStep('Closing filters menu');
        emitE2EEvent({ type: 'step', test: testId, detail: 'Closing filters menu' });
        await page.keyboard.press('Escape');
        await expect(page.getByText('Filters', { exact: true }).first()).not.toBeVisible({ timeout: 5000 });
        await expect(page).toHaveURL(/\/[^/]+\/chats/i);

        emitE2EEvent({ type: 'subtest_end', test: testId, subtestId: 'chats.filters90', status: 'passed' });
      } catch (err) {
        emitE2EEvent({
          type: 'subtest_end',
          test: testId,
          subtestId: 'chats.filters90',
          status: 'failed',
          error: String(err && err.stack ? err.stack : err),
        });
        throw err;
      }
    }

    if (runChatsMessageActions) {
      emitE2EEvent({
        type: 'subtest_start',
        test: testId,
        subtestId: 'chats.messageActions',
        subtestName: 'Open top chat and validate transcript/phone actions',
      });
      try {
        logStep('Opening top chat row');
        emitE2EEvent({ type: 'step', test: testId, detail: 'Opening top chat row' });
        await openFirstChatRow(page);

        await expect(page).toHaveURL(/\/[^/]+\/chats\/[^/?#]+/i);
        await expect(page.getByRole('heading', { name: /view chat/i }).first()).toBeVisible();

        logStep('Opening send chat transcript modal');
        emitE2EEvent({ type: 'step', test: testId, detail: 'Opening send chat transcript modal' });
        await page.getByRole('button', { name: /send chat transcript/i }).first().click();
        const transcriptEmailInput = page
          .getByPlaceholder('Email address to send transcript to')
          .first();
        await expect(transcriptEmailInput).toBeVisible({ timeout: 5000 });
        const transcriptModal = transcriptEmailInput.locator(
          'xpath=ancestor::*[contains(@class,"fi-modal-window")][1]'
        );

        logStep('Cancelling send chat transcript modal');
        emitE2EEvent({ type: 'step', test: testId, detail: 'Cancelling send chat transcript modal' });
        await transcriptModal.getByRole('button', { name: /cancel/i }).first().click();
        await expect(transcriptEmailInput).not.toBeVisible({ timeout: 5000 });

        logStep('Opening phone number popup');
        emitE2EEvent({ type: 'step', test: testId, detail: 'Opening phone number popup' });
        await page.getByRole('button', { name: /show phone number/i }).first().click();
        await expect(page.getByText('Phone Number', { exact: true }).first()).toBeVisible();

        // Remain on the same View Chat page when done.
        await expect(page).toHaveURL(/\/[^/]+\/chats\/[^/?#]+/i);
        await expect(page.getByRole('heading', { name: /view chat/i }).first()).toBeVisible();

        emitE2EEvent({ type: 'subtest_end', test: testId, subtestId: 'chats.messageActions', status: 'passed' });
      } catch (err) {
        emitE2EEvent({
          type: 'subtest_end',
          test: testId,
          subtestId: 'chats.messageActions',
          status: 'failed',
          error: String(err && err.stack ? err.stack : err),
        });
        throw err;
      }
    }

    // Explicitly end on chats page and do not navigate away.
    if (!runChatsMessageActions) {
      await expect(page).toHaveURL(/\/[^/]+\/chats/i);
    }
  });
});

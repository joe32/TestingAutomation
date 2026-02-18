const { test, expect } = require('../shared-fixture');
// @runner-name: Chats
// @runner-children: chats.load=Check chats loads;chats.tabs=Switch chats tabs (Whatsapp, Web, All)
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
    if (!runChatsLoad && !runChatsTabs) {
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
  });
});

const { test, expect } = require('../shared-fixture');
// @runner-name: Flagged Messages
// @runner-children: flagged.tabs=Switch flagged tabs (All, Completed, In Progress, New, Not A Concern, Seen, All);flagged.category=Filter category to 2nd option then back to All;flagged.moderation=Set first row moderation state to Seen;flagged.view=Open top flagged row and verify View Chat loads

function logStep(message) {
  const timestamp = new Date().toISOString();
  console.log(`[flagged-messages][${timestamp}] ${message}`);
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

async function assertFlaggedPageLoaded(page) {
  await expect(page.locator('body')).toBeVisible();
  await expect(page.getByRole('heading', { name: /flagged messages/i }).first()).toBeVisible();
  await expect(page).toHaveURL(/\/[^/]+\/flagged-messages/i);
}

async function clickFlaggedTab(page, label) {
  const candidates = [
    page.getByRole('link', { name: label, exact: true }).first(),
    page.getByRole('button', { name: label, exact: true }).first(),
    page.getByText(label, { exact: true }).first(),
  ];

  for (const locator of candidates) {
    if (await locator.count()) {
      await locator.click();
      return;
    }
  }

  throw new Error(`Could not find flagged tab "${label}"`);
}

async function openFlaggedFilters(page) {
  const candidates = [
    page.getByRole('button', { name: /filters?/i }).first(),
    page.locator('[aria-label*="filter" i]').first(),
    page.locator('[title*="filter" i]').first(),
  ];

  for (const locator of candidates) {
    try {
      if (await locator.count()) {
        await locator.click({ timeout: 3000 });
        const panelTitle = page.getByText('Filters', { exact: true }).first();
        if (await panelTitle.count()) {
          await expect(panelTitle).toBeVisible({ timeout: 5000 });
          return;
        }
      }
    } catch {
      // try next selector
    }
  }

  throw new Error('Could not open flagged filters menu');
}

function flaggedFiltersPanel(page) {
  return page
    .locator('div')
    .filter({ has: page.getByText('Filters', { exact: true }) })
    .filter({ has: page.getByText('Category', { exact: true }) })
    .first();
}

async function setVisibleFlaggedCategoryByIndex(page, index) {
  const panel = flaggedFiltersPanel(page);
  await expect(panel).toBeVisible({ timeout: 5000 });

  const result = await page.evaluate((targetIndex) => {
    const panels = Array.from(document.querySelectorAll('div')).filter((el) => {
      const txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
      return el instanceof HTMLElement
        && el.offsetParent !== null
        && txt.includes('Filters')
        && txt.includes('Category');
    });

    const panelEl = panels[0];
    if (!panelEl) return { ok: false, reason: 'visible filters panel not found' };

    const visibleSelects = Array.from(panelEl.querySelectorAll('select')).filter(
      (el) => el instanceof HTMLSelectElement && el.offsetParent !== null,
    );
    if (!visibleSelects.length) return { ok: false, reason: 'no visible select inside filters panel' };

    const categorySelect = visibleSelects.find((select) => {
      const wrappers = [
        select,
        select.parentElement,
        select.closest('div'),
        select.closest('label'),
        select.closest('fieldset'),
      ].filter(Boolean);
      return wrappers.some((node) => /category/i.test((node.textContent || '').trim()));
    }) || visibleSelects[0];

    if (targetIndex < 0 || targetIndex >= categorySelect.options.length) {
      return {
        ok: false,
        reason: `category index ${targetIndex} out of range ${categorySelect.options.length}`,
      };
    }

    categorySelect.focus();
    categorySelect.selectedIndex = targetIndex;
    categorySelect.dispatchEvent(new Event('input', { bubbles: true }));
    categorySelect.dispatchEvent(new Event('change', { bubbles: true }));

    const selectedOption = categorySelect.options[targetIndex];
    return {
      ok: true,
      selectedText: selectedOption ? selectedOption.text : '',
      selectedValue: selectedOption ? selectedOption.value : '',
    };
  }, index);

  if (!result || !result.ok) {
    throw new Error(`Could not set flagged category index ${index}: ${result ? result.reason : 'unknown reason'}`);
  }
}

async function waitForCategorySelection(page, index) {
  await page.waitForTimeout(350);
  await page.waitForLoadState('networkidle').catch(() => {});

  if (index === 0) {
    await page.waitForFunction(() => {
      const u = new URL(window.location.href);
      const value = (u.searchParams.get('tableFilters[category][value]') || '').trim().toLowerCase();
      return value === '' || value === 'all';
    }, { timeout: 12000 });
    return;
  }

  await page.waitForFunction(() => {
    const u = new URL(window.location.href);
    const value = (u.searchParams.get('tableFilters[category][value]') || '').trim().toLowerCase();
    if (value && value !== 'all') return true;
    return (document.body.innerText || '').includes('Category:');
  }, { timeout: 12000 });
}

async function setCategorySecondOption(page) {
  await setVisibleFlaggedCategoryByIndex(page, 1);
  await waitForCategorySelection(page, 1);
}

async function setCategoryAll(page) {
  await setVisibleFlaggedCategoryByIndex(page, 0);
  await waitForCategorySelection(page, 0);
}

async function getFirstFlaggedRow(page) {
  const rows = page.locator('table tbody tr');
  await expect(rows.first()).toBeVisible({ timeout: 20000 });
  return rows.first();
}

async function setFirstRowModerationSeen(page) {
  const row = await getFirstFlaggedRow(page);
  const rowSelect = row.locator('select').first();
  if (await rowSelect.count()) {
    await rowSelect.selectOption({ label: 'Seen' });
    await expect(row.locator('select').first()).toHaveValue(/seen/i);
    return;
  }

  const rowCombobox = row.getByRole('combobox').first();
  await expect(rowCombobox).toBeVisible({ timeout: 5000 });
  await rowCombobox.click();

  const seenOption = page.getByRole('option', { name: 'Seen', exact: true }).first();
  if (await seenOption.count()) {
    await seenOption.click();
  } else {
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
  }

  await expect(row).toContainText('Seen');
}

async function openTopFlaggedRow(page) {
  const row = await getFirstFlaggedRow(page);
  const detailsLink = row.locator('a[href*="/chats/"]').first();
  if (await detailsLink.count()) {
    await detailsLink.click();
    return;
  }

  const firstLink = row.getByRole('link').first();
  if (await firstLink.count()) {
    await firstLink.click();
    return;
  }

  await row.click();
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

test.describe('flagged messages', () => {
  test('load /flagged-messages and run tabs/filter/moderation/view checks', async ({ sharedPage: page }) => {
    test.setTimeout(0);
    const tasks = selectedTasks();
    const runTabs = shouldRunTask(tasks, 'flagged.tabs');
    const runCategory = shouldRunTask(tasks, 'flagged.category');
    const runModeration = shouldRunTask(tasks, 'flagged.moderation');
    const runView = shouldRunTask(tasks, 'flagged.view');
    if (!runTabs && !runCategory && !runModeration && !runView) {
      test.skip(true, 'No flagged-messages tasks selected for this run');
    }

    const testInfo = test.info();
    const testId = `${testInfo.file} :: ${testInfo.title}`;
    emitE2EEvent({ type: 'test_start', test: testId });

    let currentUrl = page.url();
    if (!currentUrl || currentUrl === 'about:blank') {
      await page.goto('/');
      currentUrl = page.url();
    }

    if (currentUrl.includes('/login')) {
      logStep('Login page detected. Waiting for human login...');
      emitE2EEvent({ type: 'step', test: testId, detail: 'Login page detected, waiting for human login' });
      await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 0 });
      currentUrl = page.url();
    }

    const tenantBasePath = getTenantBasePath(currentUrl);
    const flaggedPath = `${tenantBasePath}/flagged-messages`;
    logStep(`Navigating to ${flaggedPath}`);
    emitE2EEvent({ type: 'step', test: testId, detail: `Navigating to ${flaggedPath}` });
    await page.goto(flaggedPath, { waitUntil: 'domcontentloaded' });
    await assertFlaggedPageLoaded(page);

    if (runTabs) {
      emitE2EEvent({ type: 'subtest_start', test: testId, subtestId: 'flagged.tabs', subtestName: 'Switch flagged tabs (All, Completed, In Progress, New, Not A Concern, Seen, All)' });
      try {
        const tabs = ['Completed', 'In Progress', 'New', 'Not A Concern', 'Seen', 'All'];
        for (const tab of tabs) {
          logStep(`Switching flagged tab: ${tab}`);
          emitE2EEvent({ type: 'step', test: testId, detail: `Switching tab to ${tab}` });
          await clickFlaggedTab(page, tab);
          await assertFlaggedPageLoaded(page);
          await page.waitForTimeout(700);
        }
        emitE2EEvent({ type: 'subtest_end', test: testId, subtestId: 'flagged.tabs', status: 'passed' });
      } catch (err) {
        emitE2EEvent({ type: 'subtest_end', test: testId, subtestId: 'flagged.tabs', status: 'failed', error: String(err && err.stack ? err.stack : err) });
        throw err;
      }
    }

    if (runCategory) {
      emitE2EEvent({ type: 'subtest_start', test: testId, subtestId: 'flagged.category', subtestName: 'Filter category to 2nd option then back to All' });
      try {
        logStep('Opening flagged filters');
        emitE2EEvent({ type: 'step', test: testId, detail: 'Opening flagged filters' });
        await openFlaggedFilters(page);

        logStep('Setting category to second option (Sexual in current tenant)');
        emitE2EEvent({ type: 'step', test: testId, detail: 'Setting category to second option' });
        await setCategorySecondOption(page);
        await assertFlaggedPageLoaded(page);
        await page.keyboard.press('Escape').catch(() => {});
        await expect(page.getByText('Filters', { exact: true }).first()).not.toBeVisible({ timeout: 5000 });

        logStep('Reopening flagged filters');
        emitE2EEvent({ type: 'step', test: testId, detail: 'Reopening flagged filters' });
        await openFlaggedFilters(page);
        logStep('Setting category back to All');
        emitE2EEvent({ type: 'step', test: testId, detail: 'Setting category back to All' });
        await setCategoryAll(page);
        await assertFlaggedPageLoaded(page);

        logStep('Closing flagged filters menu');
        emitE2EEvent({ type: 'step', test: testId, detail: 'Closing flagged filters menu' });
        await page.keyboard.press('Escape');
        await expect(page.getByText('Filters', { exact: true }).first()).not.toBeVisible({ timeout: 5000 });

        emitE2EEvent({ type: 'subtest_end', test: testId, subtestId: 'flagged.category', status: 'passed' });
      } catch (err) {
        emitE2EEvent({ type: 'subtest_end', test: testId, subtestId: 'flagged.category', status: 'failed', error: String(err && err.stack ? err.stack : err) });
        throw err;
      }
    }

    if (runModeration) {
      emitE2EEvent({ type: 'subtest_start', test: testId, subtestId: 'flagged.moderation', subtestName: 'Set first row moderation state to Seen' });
      try {
        logStep('Setting first row moderation state to Seen');
        emitE2EEvent({ type: 'step', test: testId, detail: 'Setting first row moderation state to Seen' });
        await setFirstRowModerationSeen(page);
        emitE2EEvent({ type: 'subtest_end', test: testId, subtestId: 'flagged.moderation', status: 'passed' });
      } catch (err) {
        emitE2EEvent({ type: 'subtest_end', test: testId, subtestId: 'flagged.moderation', status: 'failed', error: String(err && err.stack ? err.stack : err) });
        throw err;
      }
    }

    if (runView) {
      emitE2EEvent({ type: 'subtest_start', test: testId, subtestId: 'flagged.view', subtestName: 'Open top flagged row and verify View Chat loads' });
      try {
        logStep('Opening top flagged message row');
        emitE2EEvent({ type: 'step', test: testId, detail: 'Opening top flagged message row' });
        await openTopFlaggedRow(page);
        await expect(page).toHaveURL(/\/[^/]+\/chats\/[^/?#]+/i);
        await expect(page.getByRole('heading', { name: /view chat/i }).first()).toBeVisible();
        emitE2EEvent({ type: 'subtest_end', test: testId, subtestId: 'flagged.view', status: 'passed' });
      } catch (err) {
        emitE2EEvent({ type: 'subtest_end', test: testId, subtestId: 'flagged.view', status: 'failed', error: String(err && err.stack ? err.stack : err) });
        throw err;
      }
    }
  });
});

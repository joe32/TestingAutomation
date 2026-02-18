const { test, expect } = require('@playwright/test');

function logStep(message) {
  const timestamp = new Date().toISOString();
  console.log(`[navigation][${timestamp}] ${message}`);
}

function emitE2EEvent(payload) {
  console.log(`[E2E_EVENT] ${JSON.stringify(payload)}`);
}

function getTenantBasePath(currentUrl) {
  const url = new URL(currentUrl);
  const parts = url.pathname.split('/').filter(Boolean);
  if (!parts.length) {
    throw new Error(`Could not detect tenant slug from URL: ${currentUrl}`);
  }
  return `/${parts[0]}`;
}

async function getVisibleViewTargets(page) {
  return page.evaluate(() => {
    document.querySelectorAll('[data-e2e-view-id]').forEach((el) => el.removeAttribute('data-e2e-view-id'));

    function isVisible(el) {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return (
        style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        style.pointerEvents !== 'none' &&
        rect.width > 0 &&
        rect.height > 0
      );
    }

    const targets = [];
    const clickables = Array.from(document.querySelectorAll('a, button, [role="button"], [onclick]'));
    for (const clickable of clickables) {
      if (!isVisible(clickable)) continue;

      const ownText = (clickable.textContent || '').trim().toLowerCase();
      const hasViewText = ownText === 'view';
      if (!hasViewText) continue;

      const rect = clickable.getBoundingClientRect();
      const href = clickable instanceof HTMLAnchorElement ? clickable.href : clickable.getAttribute('href');
      const id = `e2e-view-${targets.length + 1}`;
      clickable.setAttribute('data-e2e-view-id', id);
      targets.push({
        id,
        y: rect.top,
        href: href || null,
        text: (clickable.textContent || '').trim(),
      });
    }

    // Remove duplicates by target id text + vertical position.
    const dedup = [];
    const seen = new Set();
    for (const t of targets) {
      const key = `${t.text}:${Math.round(t.y)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      dedup.push(t);
    }
    return dedup;
  });
}

async function waitForDashboardViewTargets(page, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const targets = await getVisibleViewTargets(page);
    if (targets.length > 0) return targets;
    await page.waitForTimeout(750);
  }
  return [];
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

test.describe('navigation', () => {
  test('manual start, then validate all dashboard View links', async ({ page }) => {
    test.setTimeout(0);
    const testInfo = test.info();
    const testId = `${testInfo.file} :: ${testInfo.title}`;

    emitE2EEvent({ type: 'test_start', test: testId });

    logStep('Opening app root');
    emitE2EEvent({ type: 'step', test: testId, detail: 'Opening app root' });
    await page.goto('/');
    logStep(`Current URL: ${page.url()}`);
    emitE2EEvent({ type: 'step', test: testId, detail: `Current URL ${page.url()}` });

    if (page.url().includes('/login')) {
      logStep('Login page detected. Waiting for human login...');
      emitE2EEvent({ type: 'step', test: testId, detail: 'Login page detected, waiting for human login' });
      await page.waitForURL((url) => !url.pathname.includes('/login'), {
        timeout: 0,
      });
      logStep(`Login completed. URL is now: ${page.url()}`);
      emitE2EEvent({ type: 'step', test: testId, detail: `Login complete, URL ${page.url()}` });
    }

    await page.addInitScript(() => {
      const START_KEY = 'e2e:startClicked';

      function renderStartOverlay() {
        if (localStorage.getItem(START_KEY) === 'true') return;
        if (document.getElementById('e2e-start-overlay')) return;
        if (!document.body) return;

        const overlay = document.createElement('div');
        overlay.id = 'e2e-start-overlay';
        overlay.style.position = 'fixed';
        overlay.style.right = '16px';
        overlay.style.bottom = '16px';
        overlay.style.zIndex = '2147483647';
        overlay.style.background = 'rgba(0, 0, 0, 0.85)';
        overlay.style.color = '#fff';
        overlay.style.padding = '12px';
        overlay.style.borderRadius = '10px';
        overlay.style.fontFamily = 'Arial, sans-serif';

        const text = document.createElement('div');
        text.textContent = 'Click to start automation';
        text.style.marginBottom = '8px';
        text.style.fontSize = '13px';

        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = 'Start tests';
        button.style.background = '#d94a46';
        button.style.color = '#fff';
        button.style.border = 'none';
        button.style.padding = '8px 12px';
        button.style.borderRadius = '8px';
        button.style.cursor = 'pointer';
        button.style.fontWeight = '600';
        button.onclick = () => {
          localStorage.setItem(START_KEY, 'true');
          overlay.remove();
        };

        overlay.appendChild(text);
        overlay.appendChild(button);
        document.body.appendChild(overlay);
      }

      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', renderStartOverlay, { once: true });
      } else {
        renderStartOverlay();
      }
    });

    logStep('Preparing manual start overlay');
    emitE2EEvent({ type: 'step', test: testId, detail: 'Preparing manual start overlay' });
    await page.evaluate(() => localStorage.setItem('e2e:startClicked', 'false'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    logStep('Overlay should now be visible. Waiting for Start tests click...');
    emitE2EEvent({ type: 'step', test: testId, detail: 'Waiting for Start tests click' });

    await page.waitForFunction(() => localStorage.getItem('e2e:startClicked') === 'true', {
      timeout: 0,
    });

    logStep('Manual start clicked. Running dashboard View checks');
    emitE2EEvent({ type: 'step', test: testId, detail: 'Manual start clicked, running dashboard View checks' });

    const tenantBasePath = getTenantBasePath(page.url());
    logStep(`Detected tenant base path: ${tenantBasePath}`);
    emitE2EEvent({ type: 'step', test: testId, detail: `Detected tenant base path ${tenantBasePath}` });

    const dashboardPath = `${tenantBasePath}`;
    await page.goto(dashboardPath, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('body')).toBeVisible();

    const dashboardHeader = page.getByRole('heading', { name: /dashboard/i });
    await expect(dashboardHeader, 'Dashboard heading did not render before scanning View links.').toBeVisible();

    const initialTargets = await waitForDashboardViewTargets(page, 30000);
    const initialViewCount = initialTargets.length;
    expect(
      initialViewCount,
      `No Dashboard View controls found. url=${page.url()}`
    ).toBeGreaterThan(0);

    logStep(`Found ${initialViewCount} Dashboard View buttons`);
    emitE2EEvent({ type: 'step', test: testId, detail: `Found ${initialViewCount} Dashboard View buttons` });

    for (let i = 0; i < initialViewCount; i += 1) {
      await test.step(`open Dashboard View #${i + 1}`, async () => {
        await page.goto(dashboardPath, { waitUntil: 'domcontentloaded' });

        const currentTargets = await waitForDashboardViewTargets(page, 15000);
        const currentCount = currentTargets.length;
        expect(
          currentCount,
          `Dashboard View #${i + 1} missing: expected at least ${i + 1} visible View buttons, found ${currentCount}`
        ).toBeGreaterThan(i);

        const currentUrl = page.url();
        const view = currentTargets[i];
        logStep(`Clicking Dashboard View #${i + 1}${view.href ? ` (href=${view.href})` : ''}`);
        emitE2EEvent({ type: 'step', test: testId, detail: `Clicking Dashboard View #${i + 1}${view.href ? ` (href=${view.href})` : ''}` });

        const navTimeoutMs = 20000;
        let destinationUrl = currentUrl;
        let navigated = false;
        let navMethod = '';

        for (let attempt = 1; attempt <= 2 && !navigated; attempt += 1) {
          emitE2EEvent({
            type: 'step',
            test: testId,
            detail: `Dashboard View #${i + 1} click attempt ${attempt} started`,
          });

          const targetLocator = page.locator(`[data-e2e-view-id="${view.id}"]`).first();
          const clickableNow = await targetLocator.count();
          if (!clickableNow) {
            throw new Error(`Dashboard View #${i + 1} target element not found before click attempt ${attempt}`);
          }

          await targetLocator.scrollIntoViewIfNeeded();
          await targetLocator.click({ timeout: 5000 }).catch(async () => {
            await page.evaluate((viewId) => {
              const el = document.querySelector(`[data-e2e-view-id="${viewId}"]`);
              if (el) el.click();
            }, view.id);
          });

          const changed = await page
            .waitForFunction((previousUrl) => window.location.href !== previousUrl, currentUrl, {
              timeout: navTimeoutMs,
            })
            .then(() => true)
            .catch(() => false);

          if (changed) {
            await page.waitForLoadState('domcontentloaded', { timeout: navTimeoutMs }).catch(() => {});
            destinationUrl = page.url();
            navigated = true;
            navMethod = `click attempt ${attempt}`;
            break;
          }

          logStep(`Dashboard View #${i + 1} click attempt ${attempt} did not change URL yet`);
          emitE2EEvent({
            type: 'step',
            test: testId,
            detail: `Dashboard View #${i + 1} click attempt ${attempt} did not change URL yet`,
          });
        }

        if (!navigated && view.href) {
          const resolvedHref = view.href.startsWith('http')
            ? view.href
            : new URL(view.href, currentUrl).toString();

          logStep(`Dashboard View #${i + 1} click did not navigate, trying href fallback: ${resolvedHref}`);
          emitE2EEvent({
            type: 'step',
            test: testId,
            detail: `Dashboard View #${i + 1} click did not navigate, trying href fallback`,
          });

          await page.goto(resolvedHref, { waitUntil: 'domcontentloaded', timeout: navTimeoutMs });
          destinationUrl = page.url();
          if (destinationUrl !== currentUrl) {
            navigated = true;
            navMethod = 'href fallback';
          }
        }

        expect(
          navigated,
          `Dashboard View #${i + 1} did not navigate after retries. Stayed on ${currentUrl}`
        ).toBe(true);

        await expect(page.locator('body')).toBeVisible();
        await expect(
          page.locator('body'),
          `Dashboard View #${i + 1} landed on an error page (${destinationUrl})`
        ).not.toContainText(/not found/i);

        logStep(`Dashboard View #${i + 1} loaded successfully at ${destinationUrl} via ${navMethod}`);
        emitE2EEvent({ type: 'step', test: testId, detail: `Dashboard View #${i + 1} loaded successfully at ${destinationUrl} via ${navMethod}` });
      });
    }
  });
});

const { test, expect } = require('@playwright/test');

function logStep(message) {
  const timestamp = new Date().toISOString();
  console.log(`[navigation][${timestamp}] ${message}`);
}

function getTenantBasePath(currentUrl) {
  const url = new URL(currentUrl);
  const parts = url.pathname.split('/').filter(Boolean);
  if (!parts.length) {
    throw new Error(`Could not detect tenant slug from URL: ${currentUrl}`);
  }
  return `/${parts[0]}`;
}

test.describe('navigation', () => {
  test('manual start, then validate /chats', async ({ page }) => {
    test.setTimeout(0);

    logStep('Opening app root');
    await page.goto('/');
    logStep(`Current URL: ${page.url()}`);

    if (page.url().includes('/login')) {
      logStep('Login page detected. Waiting for human login...');
      await page.waitForURL((url) => !url.pathname.includes('/login'), {
        timeout: 0,
      });
      logStep(`Login completed. URL is now: ${page.url()}`);
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
    await page.evaluate(() => localStorage.setItem('e2e:startClicked', 'false'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    logStep('Overlay should now be visible. Waiting for Start tests click...');

    await page.waitForFunction(() => localStorage.getItem('e2e:startClicked') === 'true', {
      timeout: 0,
    });

    logStep('Manual start clicked. Running route checks');
    const tenantBasePath = getTenantBasePath(page.url());
    logStep(`Detected tenant base path: ${tenantBasePath}`);

    // Add more entries here as coverage expands.
    const routesToTest = [
      { name: 'Dashbaord', suffix: '/', expectedPathEnd: '/' },
      { name: 'Chats', suffix: '/chats', expectedPathEnd: '/chats' },
      { name: 'Flagged-Messages', suffix: '/flagged-messages', expectedPathEnd: '/flagged-messages' },
      { name: 'Contact-Details', suffix: '/contact-details', expectedPathEnd: '/contact-details' },
    ];

    for (const route of routesToTest) {
      await test.step(`open ${route.name}`, async () => {
        const targetPath = `${tenantBasePath}${route.suffix}`;
        logStep(`Navigating to ${targetPath}`);
        await page.goto(targetPath, { waitUntil: 'domcontentloaded' });
        logStep(`Now at: ${page.url()}`);

        const pathname = new URL(page.url()).pathname;
        expect(pathname.endsWith(route.expectedPathEnd)).toBeTruthy();
        await expect(page.locator('body')).toBeVisible();
        await expect(page.locator('body')).not.toContainText('NaN');
        logStep(`${route.name} checks passed`);
      });
    }
  });
});

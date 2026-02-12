const { test, expect } = require('@playwright/test');

test.describe('navigation', () => {
  test('can open key pages from main nav', async ({ page }) => {
    test.setTimeout(0);
    await page.goto('/');

    // If redirected to login, wait until session becomes authenticated and dashboard is reachable.
    // This supports cases where cached auth is absent at first but appears shortly after.
    if (page.url().includes('/login')) {
      await page.waitForURL((url) => !url.pathname.includes('/login'), {
        timeout: 0,
      });
    }

    // Inject a manual start button on every document load until clicked.
    // Using localStorage keeps the "clicked" state across tenant/location reloads.
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
        overlay.style.background = 'rgba(0, 0, 0, 0.8)';
        overlay.style.color = '#fff';
        overlay.style.padding = '12px';
        overlay.style.borderRadius = '10px';
        overlay.style.fontFamily = 'Arial, sans-serif';
        overlay.style.boxShadow = '0 8px 24px rgba(0,0,0,0.35)';

        const label = document.createElement('div');
        label.textContent = 'Ready to run E2E?';
        label.style.marginBottom = '8px';
        label.style.fontSize = '13px';

        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = 'Start automation';
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

        overlay.appendChild(label);
        overlay.appendChild(button);
        document.body.appendChild(overlay);
      }

      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', renderStartOverlay, { once: true });
      } else {
        renderStartOverlay();
      }
    });

    await page.evaluate(() => localStorage.setItem('e2e:startClicked', 'false'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => localStorage.getItem('e2e:startClicked') === 'true', {
      timeout: 0,
    });

    // TODO: swap to data-testid selectors from your app
    const navCases = [
      {
        name: 'Dashboard',
        nav: page.getByTestId('nav-dashboard'),
        url: /dashboard|quit-coach-demo/,
        ready: page.getByTestId('dashboard-page'),
      },
      {
        name: 'Chats',
        nav: page.getByTestId('nav-chats'),
        url: /chats/,
        ready: page.getByTestId('chats-page'),
      },
      {
        name: 'Reports',
        nav: page.getByTestId('nav-reports'),
        url: /reports/,
        ready: page.getByTestId('reports-page'),
      },
    ];

    for (const item of navCases) {
      await test.step(`open ${item.name}`, async () => {
        await item.nav.click();
        await expect(page).toHaveURL(item.url);
        await expect(item.ready).toBeVisible();
        await expect(page.locator('body')).not.toContainText('NaN');
      });
    }
  });
});

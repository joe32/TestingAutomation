const base = require('@playwright/test');

function isAlreadyClosedError(error) {
  const msg = String(error && error.message ? error.message : error || '');
  return (
    msg.includes('Target page, context or browser has been closed') ||
    msg.includes('Browser has been closed')
  );
}

const test = base.test.extend({
  sharedPage: [async ({ browser }, use) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await use(page);

    // After the full run completes, keep window visible briefly, then close.
    if (!page.isClosed()) {
      await page.waitForTimeout(3000);
    }

    try {
      await context.close();
    } catch (err) {
      if (!isAlreadyClosedError(err)) throw err;
    }
  }, { scope: 'worker', timeout: 0 }],
});

module.exports = {
  test,
  expect: base.expect,
};

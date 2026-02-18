const base = require('@playwright/test');

const test = base.test.extend({
  sharedPage: [async ({ browser }, use) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await use(page);
    await context.close();
  }, { scope: 'worker' }],
});

module.exports = {
  test,
  expect: base.expect,
};


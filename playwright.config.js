// @ts-check
const { defineConfig } = require('@playwright/test');
const isHeadless = ['1', 'true', 'yes'].includes((process.env.PLAYWRIGHT_HEADLESS || '').toLowerCase());

module.exports = defineConfig({
  testDir: './tests',
  use: {
    baseURL: 'https://app.bullet-ai.com/',
    headless: isHeadless,
  },
});

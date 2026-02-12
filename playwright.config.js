// @ts-check
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  use: {
    baseURL: 'https://app.bullet-ai.com/quit-coach-demo',
    headless: false,
  },
});

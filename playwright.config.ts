import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  webServer: {
    command: 'pnpm --filter @catbots/desktop exec vite --config vite.renderer.config.ts --host 127.0.0.1 --port 4176',
    url: 'http://127.0.0.1:4176/web-preview.html',
    reuseExistingServer: true,
  },
  use: {
    trace: 'retain-on-failure',
  },
});

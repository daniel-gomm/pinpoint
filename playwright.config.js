import { defineConfig, devices } from '@playwright/test';
import os from 'node:os';
import path from 'node:path';

const SERVER_PORT = 3999;
const WEB_PORT = 5199;
const dataDir = path.join(os.tmpdir(), `pinpoint-e2e-${process.pid}`);

export default defineConfig({
  testDir: 'e2e',
  globalSetup: './e2e/global-setup.js',
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    // CHROMIUM_PATH lets you use an already installed browser instead of `npx playwright install chromium`.
    launchOptions: process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: `node src/index.js`,
      cwd: 'server',
      env: { PORT: String(SERVER_PORT), DATA_DIR: dataDir, LAN_DETECT: 'false' },
      url: `http://localhost:${SERVER_PORT}/api/health`,
      reuseExistingServer: false,
    },
    {
      command: `npx vite --port ${WEB_PORT} --strictPort`,
      cwd: 'web',
      env: { API_URL: `http://localhost:${SERVER_PORT}` },
      url: `http://localhost:${WEB_PORT}`,
      reuseExistingServer: false,
    },
  ],
});

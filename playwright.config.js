import { defineConfig, devices } from '@playwright/test';

const PORT = process.env.TEST_PORT || 4399;

export default defineConfig({
  testDir: './tests',
  timeout: 30000,
  expect: { timeout: 10000 },
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    // WebGL needs a GPU-ish context; these flags make it reliable in headless CI.
    launchOptions: {
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist'],
    },
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: 'node server/index.js',
    port: Number(PORT),
    reuseExistingServer: false,
    stdout: 'ignore',
    stderr: 'pipe',
    env: {
      PORT: String(PORT),
      AGENTVIZ_DEMO: '1',
      AGENTVIZ_SPEED: '3',
    },
  },
});

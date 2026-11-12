import { defineConfig, devices } from '@playwright/test';

/**
 * Browser E2E smoke tests (F1). They create real accounts, workspaces and
 * messages, so they only ever run against a LOCAL throwaway database:
 *
 *   E2E_DATABASE_URL=postgresql://user@localhost:55432/scratch_db npm run test:e2e
 *
 * Playwright starts its own backend (API_PORT) and Vite dev server (WEB_PORT)
 * on dedicated ports, so an already-running dev server on 4000/5173 is never
 * touched. Authentication is exercised exactly as users do (sign-up and login
 * forms); nothing about it is stubbed or changed.
 */
const DATABASE_URL = process.env.E2E_DATABASE_URL ?? '';
if (!/^postgres(ql)?:\/\/[^@]+@(localhost|127\.0\.0\.1)(:\d+)?\//.test(DATABASE_URL)) {
  throw new Error('E2E_DATABASE_URL must point at a LOCAL throwaway PostgreSQL database (postgresql://user@localhost:PORT/db).');
}
const API_PORT = Number(process.env.E2E_API_PORT ?? 4100);
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 5174);
const API_URL = `http://localhost:${API_PORT}`;
// T.35: a local stand-in for Cloudinary's upload/download API (e2e/storage-stand-in.mjs),
// so uploads and voice messages are tested end to end without cloud credentials.
const STORAGE_PORT = Number(process.env.E2E_STORAGE_PORT ?? API_PORT + 2); // same rule in e2e/t35-uploads.spec.ts
const STORAGE = { cloud: 'e2e-cloud', apiKey: 'e2e', secret: 'e2e' };

export default defineConfig({
  testDir: './e2e',
  // Traces/screenshots of failures (git-ignored); override with E2E_OUTPUT_DIR.
  outputDir: process.env.E2E_OUTPUT_DIR ?? 'test-results',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // Calls need media devices: fake ones, auto-granted.
    permissions: ['microphone', 'camera'],
    launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], permissions: ['microphone', 'camera'] } }],
  webServer: [
    {
      command: 'npx tsx server.ts',
      cwd: '../backend',
      port: API_PORT,
      reuseExistingServer: false,
      timeout: 90_000,
      env: {
        DATABASE_URL,
        PORT: String(API_PORT),
        // A test environment (P1-A): the only runtime effect of 'test' over
        // 'development' is that the IP/per-user rate limiters are skipped —
        // the repo's existing convention for test runs (tests/setup.ts). The
        // full suite signs up more than the 10-per-15-minutes direct-signup
        // limit allows from one IP.
        NODE_ENV: 'test',
        APP_URL: `http://localhost:${WEB_PORT}`,
        // Local-only values; real secrets are never needed or read by E2E.
        JWT_SECRET: 'e2e-local-only-secret',
        CLOUDINARY_CLOUD_NAME: STORAGE.cloud,
        CLOUDINARY_API_KEY: STORAGE.apiKey,
        CLOUDINARY_API_SECRET: STORAGE.secret,
        // The SDK's standard upload_prefix setting: uploads and signed
        // downloads go to the local stand-in instead of api.cloudinary.com.
        CLOUDINARY_URL: `cloudinary://${STORAGE.apiKey}:${STORAGE.secret}@${STORAGE.cloud}?upload_prefix=http://127.0.0.1:${STORAGE_PORT}`,
        RESEND_API_KEY: '',
      },
    },
    {
      command: 'node e2e/storage-stand-in.mjs',
      port: STORAGE_PORT,
      reuseExistingServer: false,
      timeout: 30_000,
      env: {
        STORAGE_STAND_IN_PORT: String(STORAGE_PORT),
        STORAGE_STAND_IN_CLOUD: STORAGE.cloud,
        STORAGE_STAND_IN_API_KEY: STORAGE.apiKey,
        STORAGE_STAND_IN_SECRET: STORAGE.secret,
      },
    },
    {
      command: `npx vite --port ${WEB_PORT} --strictPort`,
      port: WEB_PORT,
      reuseExistingServer: false,
      timeout: 90_000,
      env: { VITE_API_URL: API_URL, VITE_BACKEND_URL: API_URL },
    },
  ],
});

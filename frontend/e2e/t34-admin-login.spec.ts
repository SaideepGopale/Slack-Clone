import { execFileSync } from 'node:child_process';
import { expect, Page, test } from '@playwright/test';
import { API_URL, newUser } from './helpers';

/**
 * T.34 — administrator sign-in in a real browser against the real API and a
 * LOCAL throwaway database: the admin login page loads, valid credentials
 * open the admin dashboard, a refresh keeps the session, and "Sign out"
 * revokes it on the server. The happy path must produce no console errors,
 * no page errors and no failed API requests.
 */

const DB = process.env.E2E_DATABASE_URL ?? '';
const LOCAL_DB = /^postgres(ql)?:\/\/[^@]+@(localhost|127\.0\.0\.1)(:\d+)?\//;

/** An ACTIVE platform administrator, created directly in the LOCAL E2E database. */
const createAdmin = () => {
  if (!LOCAL_DB.test(DB)) throw new Error('Refusing to touch a non-local database.');
  const admin = newUser('t34admin');
  const out = execFileSync(
    process.env.E2E_PSQL ?? 'psql',
    [DB, '-v', 'ON_ERROR_STOP=1', '-qtA', '-v', `username=${admin.username}`, '-v', `email=${admin.email}`, '-v', `password=${admin.password}`],
    {
      input:
        `CREATE EXTENSION IF NOT EXISTS pgcrypto;\n` +
        `INSERT INTO "User" (id, username, email, password, role, "updatedAt") ` +
        `VALUES (gen_random_uuid()::text, :'username', :'email', crypt(:'password', gen_salt('bf', 12)), 'ADMIN', now()) RETURNING id;\n`,
      stdio: ['pipe', 'pipe', 'pipe'],
    }
  ).toString();
  expect(out.trim().split('\n').filter(Boolean), 'exactly one administrator created').toHaveLength(1);
  return admin;
};

/** Everything that would count as a visible failure on the page. */
const trackProblems = (page: Page) => {
  const problems: string[] = [];
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') problems.push(`console: ${msg.text()}`);
  });
  page.on('requestfailed', (req) => {
    if (req.url().includes('/api/')) problems.push(`requestfailed: ${req.method()} ${new URL(req.url()).pathname}`);
  });
  page.on('response', (res) => {
    if (res.url().includes('/api/') && res.status() >= 400) problems.push(`HTTP ${res.status()}: ${res.request().method()} ${new URL(res.url()).pathname}`);
  });
  return problems;
};

const openAdminLogin = async (page: Page) => {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Administrator console' }).click();
  await expect(page.getByText('Workspace administration')).toBeVisible();
  await expect(page.getByLabel('Administrator e-mail')).toBeVisible();
};

const submit = async (page: Page, email: string, password: string) => {
  await page.getByLabel('Administrator e-mail').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole('button', { name: 'Sign In' }).click();
};

const meStatus = async (request: Parameters<Parameters<typeof test>[2]>[0]['request'], token: string) =>
  (await request.get(`${API_URL}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } })).status();

test('administrator login: dashboard opens, refresh keeps the session, sign out revokes it', async ({ page, request }) => {
  const admin = createAdmin();
  const problems = trackProblems(page);

  await openAdminLogin(page);
  await submit(page, admin.email, admin.password);

  await page.waitForURL(/\/admin$/);
  await expect(page.getByRole('heading', { level: 1, name: /System Overview/ })).toBeVisible();
  const token = await page.evaluate(() => localStorage.getItem('token'));
  expect(token).toBeTruthy();
  expect(await meStatus(request, token!)).toBe(200);

  // Refresh: still signed in, still on the dashboard.
  await page.reload();
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByRole('heading', { level: 1, name: /System Overview/ })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('token'))).toBe(token);

  // Another admin section loads too.
  await page.getByRole('complementary', { name: 'Administration' }).getByRole('button', { name: 'User Management' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Users' })).toBeVisible();

  // Sign out: back to the login page, and the server no longer accepts the token.
  const logout = page.waitForResponse((res) => res.url().endsWith('/api/auth/logout'));
  await page.getByRole('complementary', { name: 'Administration' }).getByRole('button', { name: 'Sign out' }).click();
  expect((await logout).status()).toBe(200);
  await page.waitForURL(/\/login$/);
  expect(await page.evaluate(() => localStorage.getItem('token'))).toBeNull();
  expect(await meStatus(request, token!)).toBe(401);
  // Visiting the console again needs a new sign-in.
  await page.goto('/admin');
  await page.waitForURL(/\/login$/);

  expect(problems).toEqual([]);
});

test('administrator login with a wrong password shows the error and opens nothing', async ({ page }) => {
  const admin = createAdmin();
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));

  await openAdminLogin(page);
  await submit(page, admin.email, `${admin.password}-wrong`);
  // Shown inline on the form (and also as a toast).
  await expect(page.getByRole('main').getByRole('alert').filter({ hasText: 'Invalid credentials' })).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
  expect(await page.evaluate(() => localStorage.getItem('token'))).toBeNull();
  expect(errors).toEqual([]);
});

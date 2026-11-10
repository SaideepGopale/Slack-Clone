import { execFileSync } from 'node:child_process';
import { APIRequestContext, expect, Page } from '@playwright/test';

export const API_URL = `http://localhost:${process.env.E2E_API_PORT ?? 4100}`;

export interface E2EUser {
  username: string;
  email: string;
  password: string;
}

let counter = 0;
export const newUser = (label: string): E2EUser => {
  const id = `${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  return { username: `${label}_${id}`, email: `e2e_${label}_${id}@example.test`, password: `E2e-pass-${id}!` };
};

/** Collects uncaught page errors; assert it's empty at the end of a test. */
export const trackPageErrors = (page: Page) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));
  return errors;
};

/**
 * Gives a test a fresh, signed-in account. T.21: public sign-up is now
 * invitation-only, so throwaway accounts are created directly in the LOCAL
 * E2E database (bcrypt via pgcrypto — the same $2a$ hashes the server
 * verifies), then signed in through the real login form. The invited sign-up
 * flow itself is covered end to end in stage2-team-lead.spec.ts.
 */
export const signUp = async (page: Page, user: E2EUser) => {
  if (!LOCAL_DB.test(DB)) throw new Error('Refusing to touch a non-local database.');
  const out = execFileSync(
    process.env.E2E_PSQL ?? 'psql',
    [DB, '-v', 'ON_ERROR_STOP=1', '-qtA', '-v', `username=${user.username}`, '-v', `email=${user.email}`, '-v', `password=${user.password}`],
    {
      input:
        `CREATE EXTENSION IF NOT EXISTS pgcrypto;\n` +
        `INSERT INTO "User" (id, username, email, password, "updatedAt") ` +
        `VALUES (gen_random_uuid()::text, :'username', :'email', crypt(:'password', gen_salt('bf', 12)), now()) RETURNING id;\n`,
      stdio: ['pipe', 'pipe', 'pipe'], // capture stderr (a NOTICE on re-run; errors surface in the thrown exception)
    }
  ).toString();
  expect(out.trim().split('\n').filter(Boolean), 'exactly one account created').toHaveLength(1);
  await logIn(page, user);
};

/** Logs in through the real form. */
export const logIn = async (page: Page, user: E2EUser) => {
  await page.goto('/login');
  const form = page.locator('form').filter({ has: page.getByRole('button', { name: 'Sign In' }) });
  await form.locator('input[type="email"]').fill(user.email);
  await form.locator('input[type="password"]').fill(user.password);
  await form.getByRole('button', { name: 'Sign In' }).click();
};

const DB = process.env.E2E_DATABASE_URL ?? '';
const LOCAL_DB = /^postgres(ql)?:\/\/[^@]+@(localhost|127\.0\.0\.1)(:\d+)?\//;

/**
 * Stage 1: only Team Leads (and Company Admins) create workspaces and
 * organizations, and only Team Leads can be made workspace/organization
 * admins. There is no UI to grant the tier yet (a Company Admin flow comes in
 * a later stage), so tests grant it directly in the LOCAL throwaway E2E
 * database — the same guard playwright.config.ts applies.
 */
export const makeTeamLead = (email: string) => {
  if (!LOCAL_DB.test(DB)) throw new Error('Refusing to touch a non-local database.');
  const out = execFileSync(process.env.E2E_PSQL ?? 'psql', [DB, '-v', 'ON_ERROR_STOP=1', '-qtA', '-v', `email=${email}`], {
    input:
      `INSERT INTO "AccountTierGrant" ("userId", "tier", "updatedAt") SELECT id, 'TEAM_LEAD', now() FROM "User" WHERE email = :'email' ` +
      `ON CONFLICT ("userId") DO UPDATE SET "tier" = 'TEAM_LEAD', "updatedAt" = now() RETURNING "userId";\n`,
  }).toString();
  expect(out.trim().split('\n').filter(Boolean), 'exactly one Team Lead granted').toHaveLength(1);
};

/**
 * Creates a workspace from the rail's dialog (or an inline create form) and lands in its General channel.
 * Stage 1: the signed-in account is made a Team Lead first (workspace creators are Team Leads).
 */
export const createWorkspace = async (page: Page, name: string) => {
  // P2: new accounts land in SmartConnect Collab, so the "not in a workspace
  // yet" form is usually gone — open the rail's create dialog instead.
  const inlineForm = page.getByPlaceholder('Acme Corp');
  const rail = page.getByRole('navigation', { name: 'Workspaces' });
  const railButton = rail.getByRole('button', { name: 'Create a workspace' });
  // Signed in once the workspace rail shows: grant the creator the Team Lead tier.
  await expect(inlineForm.or(rail).first()).toBeVisible();
  const signedIn = JSON.parse((await page.evaluate(() => localStorage.getItem('user'))) ?? 'null') as { email?: string } | null;
  expect(signedIn?.email, 'a signed-in account').toBeTruthy();
  makeTeamLead(signedIn!.email!);
  // Stage 3 (T.22): "Create a workspace" is only offered to accounts that may
  // create workspaces — reload so the page picks up the newly granted tier.
  await page.reload();
  await expect(inlineForm.or(railButton).first()).toBeVisible();
  if (!(await inlineForm.isVisible())) await railButton.click();
  const previous = new URL(page.url()).pathname.split('/')[1];
  await page.getByPlaceholder('Acme Corp').fill(name);
  await page.getByRole('button', { name: 'Create Workspace' }).click();
  // Wait for a channel URL in a DIFFERENT workspace than the one we were in.
  await page.waitForURL((url) => /^\/[0-9a-f-]{36}\/c\/[0-9a-f-]{36}$/.test(url.pathname) && url.pathname.split('/')[1] !== previous);
  return workspaceIdFrom(page);
};

export const workspaceIdFrom = (page: Page) => new URL(page.url()).pathname.split('/')[1];

export const sendMessage = async (page: Page, text: string) => {
  const editor = page.locator('main [contenteditable="true"]').first();
  await editor.click();
  await editor.pressSequentially(text);
  await editor.press('Enter');
};

export const tokenOf = async (page: Page) => {
  const token = await page.evaluate(() => localStorage.getItem('token'));
  expect(token, 'signed-in session token').toBeTruthy();
  return token as string;
};

/** Authenticated REST call with a user's own session token (setup only — the UI is what's under test). */
export const apiAs = (request: APIRequestContext, token: string) => ({
  get: (path: string) => request.get(`${API_URL}${path}`, { headers: { Authorization: `Bearer ${token}` } }),
  post: (path: string, data?: unknown) => request.post(`${API_URL}${path}`, { headers: { Authorization: `Bearer ${token}` }, data }),
  put: (path: string, data?: unknown) => request.put(`${API_URL}${path}`, { headers: { Authorization: `Bearer ${token}` }, data }),
  patch: (path: string, data?: unknown) => request.patch(`${API_URL}${path}`, { headers: { Authorization: `Bearer ${token}` }, data }),
});

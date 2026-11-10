import { execFileSync } from 'node:child_process';
import { Browser, expect, Page, test } from '@playwright/test';
import { API_URL, apiAs, createWorkspace, logIn, makeTeamLead, newUser, sendMessage, signUp, tokenOf, trackPageErrors } from './helpers';

/**
 * Stage 4 (T.23), end to end: the Company Admin opens Admin → Company →
 * Workspace Overview, inspects a Team Lead's workspace (metadata only — no
 * message content, and still no access to its conversations); Team Leads and
 * Members can't open the overview; the workspace switcher never shows
 * "Create a workspace" while the account level is loading.
 */
const DB = process.env.E2E_DATABASE_URL ?? '';
const LOCAL_DB = /^postgres(ql)?:\/\/[^@]+@(localhost|127\.0\.0\.1)(:\d+)?\//;
const UUID = '[0-9a-f-]{36}';
const freshPage = async (browser: Browser) => (await browser.newContext()).newPage();
const promoteToCompanyAdmin = (email: string) => {
  if (!LOCAL_DB.test(DB)) throw new Error('Refusing to touch a non-local database.');
  const out = execFileSync(process.env.E2E_PSQL ?? 'psql', [DB, '-v', 'ON_ERROR_STOP=1', '-qtA', '-v', `email=${email}`], {
    input: `UPDATE "User" SET role = 'ADMIN' WHERE email = :'email' RETURNING id;\n`,
  }).toString();
  expect(out.trim().split('\n').filter(Boolean)).toHaveLength(1);
};
/** Holds /api/me/hierarchy back so the "still loading" state is observable. */
const slowHierarchy = async (page: Page, ms: number) =>
  page.route('**/api/me/hierarchy', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    await route.continue();
  });

test('Stage 4: Company Admin workspace overview — metadata only; leads and members are refused; switcher loading fix', async ({ browser, request }) => {
  test.setTimeout(180_000);
  const run = Date.now().toString(36);

  // A Team Lead's workspace with a message the admin must never see.
  const lead = newUser('s4lead');
  const l = await freshPage(browser);
  const leadErrors = trackPageErrors(l);
  await signUp(l, lead);
  const workspaceName = `Overview ${run}`;
  const workspaceId = await createWorkspace(l, workspaceName);
  await sendMessage(l, `TOP SECRET ${run}`);
  await expect(l.getByText(`TOP SECRET ${run}`)).toBeVisible();
  const generalChannelId = new URL(l.url()).pathname.split('/')[3];

  const member = newUser('s4member');
  const m = await freshPage(browser);
  await signUp(m, member);
  await m.waitForURL(new RegExp(`/${UUID}/`));

  await test.step('1. Team Leads and Members cannot open the company overview — UI or API', async () => {
    for (const [page, user] of [[l, lead], [m, member]] as const) {
      await page.goto('/admin');
      await expect(page).not.toHaveURL(/\/admin$/);
      expect((await apiAs(request, await tokenOf(page)).get('/api/company-overview/summary')).status(), user.email).toBe(403);
      expect((await apiAs(request, await tokenOf(page)).get(`/api/company-overview/workspaces/${workspaceId}`)).status()).toBe(403);
    }
  });

  await test.step('2. the workspace switcher never shows "Create a workspace" while the level loads', async () => {
    await slowHierarchy(m, 2_000);
    await slowHierarchy(l, 2_000);
    for (const page of [m, l]) await page.goto('/');
    const createIn = (page: Page) => page.getByRole('navigation', { name: 'Workspaces' }).getByRole('button', { name: 'Create a workspace' });
    for (const page of [m, l]) {
      await expect(page.getByRole('navigation', { name: 'Workspaces' })).toBeVisible();
      await expect(createIn(page)).toHaveCount(0); // still loading
    }
    await expect(createIn(l)).toBeVisible({ timeout: 10_000 }); // Team Lead, once loaded
    await m.waitForTimeout(2_500);
    await expect(createIn(m)).toHaveCount(0); // Member, after loading too
    await l.unroute('**/api/me/hierarchy');
    await m.unroute('**/api/me/hierarchy');
  });

  const adminUser = newUser('s4admin');
  const admin = await freshPage(browser);
  const adminErrors = trackPageErrors(admin);
  await test.step('3. the Company Admin opens Admin → Company → Workspace Overview', async () => {
    const boot = await freshPage(browser);
    await signUp(boot, adminUser);
    await boot.waitForURL(new RegExp(`/${UUID}/`));
    await boot.context().close();
    promoteToCompanyAdmin(adminUser.email);
    await logIn(admin, adminUser);
    await admin.waitForURL('**/admin');
    await admin.getByRole('button', { name: /Workspace Overview/ }).click();
    await expect(admin.getByRole('heading', { name: /Workspace Overview/ })).toBeVisible();
    const metrics = admin.getByRole('region', { name: 'Company metrics' });
    await expect(metrics.getByText('Total workspaces')).toBeVisible();
    const table = admin.getByRole('table', { name: 'Workspaces' });
    await expect(table.getByText('SmartConnect Collab')).toBeVisible();
    await expect(table.getByRole('row').filter({ hasText: 'SmartConnect Collab' }).getByText('Shared default')).toBeVisible();
    await admin.getByRole('searchbox', { name: 'Search workspaces' }).fill(workspaceName);
    const row = table.getByRole('row').filter({ hasText: workspaceName });
    await expect(row).toBeVisible();
    await expect(row.getByText(lead.username, { exact: true })).toBeVisible();
  });

  await test.step('4. workspace details are metadata only, and grant no access to conversations', async () => {
    await admin.getByRole('button', { name: `View details for ${workspaceName}` }).click();
    const dialog = admin.getByRole('dialog', { name: workspaceName });
    await expect(dialog.getByText(/not shown here/i)).toBeVisible();
    await expect(dialog.getByRole('list', { name: 'Members' }).getByText(lead.username, { exact: true })).toBeVisible();
    await expect(dialog.getByText(`TOP SECRET ${run}`)).toHaveCount(0);
    await expect(admin.getByText(`TOP SECRET ${run}`)).toHaveCount(0);
    const api = apiAs(request, await tokenOf(admin));
    const detail = await (await api.get(`/api/company-overview/workspaces/${workspaceId}`)).text();
    expect(detail).not.toContain('TOP SECRET');
    expect((await api.get(`/api/channels/${generalChannelId}/messages`)).status()).toBe(403);
    expect((await api.get(`/api/workspaces/${workspaceId}/channels`)).status()).toBe(403);
    await dialog.getByRole('button', { name: 'Done' }).click();
  });

  await test.step('5. the Team Lead overview links to that lead’s workspaces; the console fits a tablet screen', async () => {
    await admin.getByRole('tab', { name: 'Team Leads' }).click();
    await admin.getByRole('searchbox', { name: 'Search Team Leads' }).fill(lead.username);
    await admin.getByRole('button', { name: new RegExp(`View workspaces of`) }).first().click();
    await expect(admin.getByText(/^Team Lead: /)).toBeVisible();
    await expect(admin.getByRole('table', { name: 'Workspaces' }).getByRole('row').filter({ hasText: workspaceName })).toBeVisible();
    await admin.setViewportSize({ width: 1024, height: 768 });
    const overflow = await admin.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });

  expect(adminErrors).toEqual([]);
  expect(leadErrors).toEqual([]);
  expect(API_URL).toBeTruthy();
});

import { Browser, expect, Page, test } from '@playwright/test';
import { apiAs, createWorkspace, E2EUser, makeTeamLead, newUser, signUp, tokenOf, trackPageErrors, workspaceIdFrom } from './helpers';

/**
 * F2 — organization and workspace administration, end to end through the UI
 * (the API is used only to set up the joining side, and to verify outcomes).
 */

const UUID = '[0-9a-f-]{36}';

/** Captures clipboard writes (the real clipboard needs OS permissions). */
const captureClipboard = async (page: Page) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          (window as unknown as { __copied: string[] }).__copied = [...((window as unknown as { __copied?: string[] }).__copied ?? []), text];
        },
      },
    });
  });
};
const lastCopied = (page: Page) => page.evaluate(() => (window as unknown as { __copied?: string[] }).__copied?.at(-1) ?? null);

const openWorkspaceMenuItem = async (page: Page, workspaceName: string, item: RegExp | string) => {
  await page.getByRole('button', { name: `${workspaceName} options` }).click();
  await page.getByRole('button', { name: item }).click();
};

const newPage = async (browser: Browser) => (await browser.newContext()).newPage();

/** Joins `user` to a workspace through the existing invite-link + approval API. */
const joinViaApi = async (request: Parameters<typeof apiAs>[0], ownerToken: string, joinerToken: string, workspaceId: string, joiner: E2EUser) => {
  const owner = apiAs(request, ownerToken);
  const link = await (await owner.get(`/api/workspaces/${workspaceId}/invite-link`)).json();
  const token = new URL(link.url).searchParams.get('token');
  expect((await (await apiAs(request, joinerToken).post('/api/workspaces/join', { token })).json()).status).toBe('pending');
  const requests = await (await owner.get(`/api/workspaces/${workspaceId}/requests`)).json();
  const mine = requests.find((r: { user: { username: string } }) => r.user.username === joiner.username);
  expect((await owner.put(`/api/workspaces/${workspaceId}/requests/${mine.id}`, { action: 'APPROVE' })).ok()).toBeTruthy();
};

test('organization creation, workspace creation inside it, organization-aware navigation and settings', async ({ page }) => {
  const errors = trackPageErrors(page);
  const user = newUser('orgowner');
  await signUp(page, user);
  await createWorkspace(page, `Home ${user.username}`);

  // Rail → Organizations → create an organization (creator becomes OWNER).
  const rail = page.getByRole('navigation', { name: 'Workspaces' });
  await rail.getByRole('button', { name: 'Organizations' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Organizations' })).toBeVisible();
  await page.getByRole('button', { name: 'New organization' }).click();
  const orgDialog = page.getByRole('dialog', { name: 'Create an organization' });
  await orgDialog.getByLabel('Organization name').fill(`Org ${user.username}`);
  await orgDialog.getByRole('button', { name: 'Create organization' }).click();
  await page.waitForURL(new RegExp(`/${UUID}/organizations/${UUID}$`));
  const organizationId = new URL(page.url()).pathname.split('/')[3];
  await expect(page.getByRole('heading', { level: 1, name: `Org ${user.username}` })).toBeVisible();
  await expect(page.locator('main').getByText('Owner', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('No workspaces yet')).toBeVisible();

  // Create a workspace inside it.
  await page.getByRole('button', { name: 'New workspace' }).click();
  const wsDialog = page.getByRole('dialog', { name: 'Create a workspace' });
  await expect(wsDialog).toContainText(`In Org ${user.username}`);
  await wsDialog.getByPlaceholder('Acme Corp').fill(`Ops ${user.username}`);
  await wsDialog.getByRole('button', { name: 'Create Workspace' }).click();
  await page.waitForURL(new RegExp(`^.*/${UUID}/c/${UUID}$`));
  const opsId = workspaceIdFrom(page);

  // P2: the rail groups by access (Collab / My workspaces / Shared with me); the organization shows on hover.
  const group = rail.getByRole('group', { name: 'My workspaces' });
  await expect(group.getByRole('button', { name: `Ops ${user.username} (current workspace)` })).toHaveAttribute('aria-current', 'page');

  // Workspace settings from the workspace menu: rename + channel policy.
  await openWorkspaceMenuItem(page, `Ops ${user.username}`, 'Workspace settings');
  await page.waitForURL(new RegExp(`/${opsId}/settings$`));
  await expect(page.getByRole('heading', { level: 1, name: `Ops ${user.username}` })).toBeVisible();
  await page.getByLabel('Name', { exact: true }).fill(`Ops2 ${user.username}`);
  await page.getByLabel('Description').fill('Runbooks and on-call');
  await page.getByRole('radio', { name: /Only admins/ }).check();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('heading', { level: 1, name: `Ops2 ${user.username}` })).toBeVisible();
  // The shared store updated the rail and sidebar without a reload.
  await expect(group.getByRole('button', { name: `Ops2 ${user.username} (current workspace)` })).toBeVisible();

  // Organization page shows it, as the current workspace, with its description.
  await page.getByRole('link', { name: `Org ${user.username}` }).click();
  await page.waitForURL(new RegExp(`/${opsId}/organizations/${organizationId}$`));
  const list = page.getByRole('list', { name: `Workspaces in Org ${user.username}` });
  await expect(list).toContainText(`Ops2 ${user.username}`);
  await expect(list).toContainText('Runbooks and on-call');
  expect(errors).toEqual([]);
});

test('invitations, join requests, live role-based controls and membership management', async ({ browser, request }) => {
  const a = await newPage(browser);
  const b = await newPage(browser);
  const errorsA = trackPageErrors(a);
  const errorsB = trackPageErrors(b);
  await captureClipboard(a);
  const alice = newUser('inviter');
  const bob = newUser('joiner');

  await signUp(a, alice);
  const workspaceName = `Crew ${alice.username}`;
  const workspaceId = await createWorkspace(a, workspaceName);
  await signUp(b, bob);
  // P2: every account starts in SmartConnect Collab (there is no "no workspace" screen any more).
  await expect(b.getByRole('navigation', { name: 'Workspaces' }).getByRole('group', { name: 'SmartConnect Collab' })).toBeVisible();

  // Alice: settings → Invitations.
  await openWorkspaceMenuItem(a, workspaceName, 'Workspace settings');
  await a.getByRole('tab', { name: 'Invitations' }).click();

  // Invite by e-mail. The token in the create response never reaches the page.
  const inviteeEmail = `invitee_${alice.username}@example.test`;
  await a.getByLabel('E-mail address').fill(inviteeEmail);
  const [created] = await Promise.all([
    a.waitForResponse((r) => r.url().endsWith(`/api/workspaces/${workspaceId}/invites`) && r.request().method() === 'POST'),
    // T.36: labelled "Create invitation" when the server cannot send e-mail (as in E2E).
    a.getByRole('button', { name: /^(Send invite|Create invitation)$/ }).click(),
  ]);
  const createdBody = await created.json();
  expect(typeof createdBody.token).toBe('string');
  const invitations = a.getByRole('list', { name: 'Invitations' });
  const row = invitations.getByRole('listitem').filter({ hasText: inviteeEmail });
  await expect(row).toContainText('Pending');
  expect(await a.content()).not.toContain(createdBody.token);
  // The manager listing itself carries no tokens.
  const listing = await (await apiAs(request, await tokenOf(a)).get(`/api/workspaces/${workspaceId}/invitations`)).json();
  expect(JSON.stringify(listing)).not.toContain(createdBody.token);
  expect(listing[0]).not.toHaveProperty('token');

  // Revoke it.
  await row.getByRole('button', { name: `Revoke invitation for ${inviteeEmail}` }).click();
  await a.getByRole('dialog').getByRole('button', { name: 'Revoke invitation' }).click();
  await expect(row).toContainText('Revoked');
  await expect(row.getByRole('button', { name: /Revoke invitation/ })).toHaveCount(0);

  // Copy the invite link from the UI; Bob uses it (API side), Alice approves in the UI.
  await a.getByRole('button', { name: 'Copy invite link' }).click();
  await expect.poll(() => lastCopied(a)).toContain('/join-workspace?token=');
  const copied = (await lastCopied(a)) as string;
  const linkToken = new URL(copied).searchParams.get('token');
  const apiB = apiAs(request, await tokenOf(b));
  expect((await (await apiB.post('/api/workspaces/join', { token: linkToken })).json()).status).toBe('pending');
  await a.getByRole('tab', { name: 'Join requests' }).click();
  const requests = a.getByRole('list', { name: 'Join requests' });
  await expect(requests).toContainText(bob.username);
  await a.getByRole('button', { name: `Approve ${bob.username}` }).click();
  await expect(a.getByText('No pending join requests')).toBeVisible();

  // Bob is in, as a plain member: read-only settings, no management tabs.
  // (P2: opened directly — "/" returns him to Collab, his last active workspace.)
  await b.goto(`/${workspaceId}`);
  await b.waitForURL(new RegExp(`/${workspaceId}/c/${UUID}$`));
  await openWorkspaceMenuItem(b, workspaceName, 'Workspace settings');
  await b.waitForURL(new RegExp(`/${workspaceId}/settings$`));
  await expect(b.getByLabel('Name', { exact: true })).toBeDisabled();
  await expect(b.getByRole('tab')).toHaveText(['General', /^Members/]);
  await expect(b.getByRole('button', { name: 'Leave workspace' })).toBeVisible();
  await expect(b.getByRole('button', { name: 'Delete workspace' })).toHaveCount(0);
  // A deep link to a management tab falls back to General.
  await b.goto(`/${workspaceId}/settings?tab=invitations`);
  await expect(b.getByRole('tab', { name: 'General' })).toHaveAttribute('aria-selected', 'true');
  await expect(b.getByRole('tab', { name: 'Invitations' })).toHaveCount(0);
  // And the server refuses anyway.
  expect((await apiB.get(`/api/workspaces/${workspaceId}/invitations`)).status()).toBe(403);
  // Back to plain General (clears the ?tab=invitations deep link), so a later
  // promotion doesn't honour that stale link and switch tabs mid-assertion.
  await b.getByRole('tab', { name: 'General' }).click();
  await expect(b).toHaveURL(new RegExp(`/${workspaceId}/settings$`));

  // Alice promotes Bob → Bob's open page gains the controls live (no reload).
  // Stage 1: only Team Leads can be made workspace admins.
  makeTeamLead(bob.email);
  await a.getByRole('tab', { name: /^Members/ }).click();
  await a.getByLabel(`Role for ${bob.username}`).selectOption('ADMIN');
  await expect(b.getByLabel('Name', { exact: true })).toBeEnabled();
  await expect(b.getByRole('tab', { name: 'Invitations' })).toBeVisible();
  // …and loses them live when demoted.
  await a.getByLabel(`Role for ${bob.username}`).selectOption('MEMBER');
  await expect(b.getByLabel('Name', { exact: true })).toBeDisabled();
  await expect(b.getByRole('tab', { name: 'Invitations' })).toHaveCount(0);

  // Alice removes Bob → Bob is taken out of the workspace immediately.
  await a.getByRole('button', { name: `Remove ${bob.username}` }).click();
  await a.getByRole('dialog').getByRole('button', { name: 'Remove from workspace' }).click();
  await expect(a.getByRole('list', { name: 'Workspace members' })).not.toContainText(bob.username);
  // P2: Bob still has SmartConnect Collab, so he's moved there; the removed workspace is gone from his rail.
  await b.waitForURL((url) => /^\/[0-9a-f-]{36}(\/|$)/.test(url.pathname) && !url.pathname.startsWith(`/${workspaceId}`));
  await expect(b.getByRole('navigation', { name: 'Workspaces' }).getByRole('button', { name: new RegExp(workspaceName) })).toHaveCount(0);

  // Revoke every invite link → the copied link stops working.
  await a.getByRole('tab', { name: 'Invitations' }).click();
  await a.getByRole('button', { name: 'Revoke all invite links' }).click();
  await a.getByRole('dialog').getByRole('button', { name: 'Revoke all links' }).click();
  await expect(a.getByText(/invite links? revoked/)).toBeVisible();
  expect((await apiB.post('/api/workspaces/join', { token: linkToken })).status()).toBe(400);

  expect(errorsA).toEqual([]);
  expect(errorsB).toEqual([]);
});

test('organization admins manage workspaces without content access; organizations are isolated', async ({ browser, request }) => {
  const o = await newPage(browser);
  const d = await newPage(browser);
  const e = await newPage(browser);
  const errors = [trackPageErrors(o), trackPageErrors(d), trackPageErrors(e)];
  const olga = newUser('olga');
  const dan = newUser('dan');
  const eve = newUser('eve');

  await signUp(o, olga);
  const mainName = `Main ${olga.username}`;
  const mainId = await createWorkspace(o, mainName);
  await signUp(d, dan);
  const danHome = await createWorkspace(d, `DanHome ${dan.username}`);
  await signUp(e, eve);
  const eveHome = await createWorkspace(e, `EveHome ${eve.username}`);
  await joinViaApi(request, await tokenOf(o), await tokenOf(d), mainId, dan);

  // Olga makes Dan an organization admin (organization page → Members).
  await o.getByRole('navigation', { name: 'Workspaces' }).getByRole('button', { name: 'Organizations' }).click();
  await o.getByRole('list', { name: 'Your organizations' }).getByRole('link', { name: new RegExp(mainName) }).click();
  await o.waitForURL(new RegExp(`/${mainId}/organizations/${UUID}$`));
  const organizationId = new URL(o.url()).pathname.split('/')[3];
  await o.getByRole('tab', { name: 'Members' }).click();
  await o.getByLabel(`Organization role for ${dan.username}`).selectOption('ADMIN');
  await expect(o.getByLabel(`Organization role for ${dan.username}`)).toHaveValue('ADMIN');

  // Olga creates a second workspace in the organization; Dan isn't a member of it.
  await o.getByRole('tab', { name: /^Workspaces/ }).click();
  await o.getByRole('button', { name: 'New workspace' }).click();
  const secretName = `Secret ${olga.username}`;
  await o.getByRole('dialog', { name: 'Create a workspace' }).getByPlaceholder('Acme Corp').fill(secretName);
  await o.getByRole('dialog', { name: 'Create a workspace' }).getByRole('button', { name: 'Create Workspace' }).click();
  await o.waitForURL(new RegExp(`/${UUID}/c/${UUID}$`));
  const secretId = workspaceIdFrom(o);
  expect(secretId).not.toBe(mainId);

  // Dan: organization page lists it as "Not a member", with Manage but no Open.
  const contentRequests: string[] = [];
  d.on('request', (r) => {
    if (new RegExp(`/api/workspaces/${secretId}/(channels|dms|unread)`).test(r.url())) contentRequests.push(r.url());
  });
  await d.goto(`/${danHome}/organizations`);
  await d.getByRole('list', { name: 'Your organizations' }).getByRole('link', { name: new RegExp(mainName) }).click();
  const list = d.getByRole('list', { name: new RegExp(`^Workspaces in`) });
  const secretRow = list.getByRole('listitem').filter({ hasText: secretName });
  await expect(secretRow).toContainText('Not a member');
  await expect(secretRow.getByRole('button', { name: `Open ${secretName}` })).toHaveCount(0);
  await secretRow.getByRole('button', { name: `Manage ${secretName}` }).click();
  await d.waitForURL(new RegExp(`/${danHome}/organizations/${organizationId}/workspaces/${secretId}$`));
  await expect(d.getByRole('heading', { level: 1, name: secretName })).toBeVisible();
  await expect(d.getByText(/Its channels and messages are visible only to its members/)).toBeVisible();
  await expect(d.getByRole('tab', { name: 'Invitations' })).toBeVisible();

  // Dan manages it (description) without membership…
  await d.getByLabel('Description').fill('Managed by the organization admin');
  await d.getByRole('button', { name: 'Save changes' }).click();
  await expect(d.getByText('Workspace settings saved.')).toBeVisible();
  const asOlga = apiAs(request, await tokenOf(o));
  expect((await (await asOlga.get(`/api/workspaces/${secretId}/settings`)).json()).description).toBe('Managed by the organization admin');
  // …but gets no content: the server refuses, the UI never asked, and a direct URL bounces.
  const asDan = apiAs(request, await tokenOf(d));
  expect((await asDan.get(`/api/workspaces/${secretId}/channels`)).status()).toBe(403);
  expect(contentRequests).toEqual([]);

  // Isolation: Eve (another organization) learns nothing.
  await e.goto(`/${eveHome}/organizations/${organizationId}`);
  await expect(e.getByText('Organization not found')).toBeVisible();
  await e.goto(`/${eveHome}/organizations/${organizationId}/workspaces/${secretId}`);
  await expect(e.getByText(/You don't have permission|Workspace not found/)).toBeVisible();
  expect(await e.content()).not.toContain(secretName);
  await e.goto(`/${eveHome}/organizations`);
  await expect(e.getByRole('list', { name: 'Your organizations' })).not.toContainText(mainName);
  expect((await apiAs(request, await tokenOf(e)).get(`/api/organizations/${organizationId}`)).status()).toBe(404);
  await e.goto(`/${secretId}`);
  await e.waitForURL(new RegExp(`/${eveHome}(/|$)`));

  // Dan deletes the workspace from the organization page; Olga, who is inside
  // it, is moved to her remaining workspace.
  await d.getByRole('button', { name: 'Delete workspace' }).click();
  const dialog = d.getByRole('dialog', { name: `Delete "${secretName}"?` });
  await dialog.getByLabel(`Type "${secretName}" to confirm`).fill(secretName);
  await dialog.getByRole('button', { name: 'Delete Workspace' }).click();
  await d.waitForURL(new RegExp(`/${danHome}/organizations/${organizationId}$`));
  await expect(d.getByRole('list', { name: /^Workspaces in/ })).not.toContainText(secretName);
  await o.waitForURL(new RegExp(`/${mainId}(/|$)`));
  await expect(o.getByRole('navigation', { name: 'Workspaces' }).getByRole('button', { name: new RegExp(`^${secretName}`) })).toHaveCount(0);

  // Dan leaves Main from its settings (reached from the organization page): he
  // returns to the organization, where — still an organization admin — Main is
  // now "Not a member" but manageable, and it's gone from his rail.
  const mainRow = d.getByRole('list', { name: /^Workspaces in/ }).getByRole('listitem').filter({ hasText: mainName });
  await mainRow.getByRole('button', { name: `Settings for ${mainName}` }).click();
  await d.waitForURL(new RegExp(`/${danHome}/organizations/${organizationId}/workspaces/${mainId}$`));
  await d.getByRole('button', { name: 'Leave workspace' }).click();
  await d.getByRole('dialog').getByRole('button', { name: 'Leave workspace' }).click();
  await d.waitForURL(new RegExp(`/${danHome}/organizations/${organizationId}$`));
  await expect(mainRow).toContainText('Not a member');
  await expect(mainRow.getByRole('button', { name: `Manage ${mainName}` })).toBeVisible();
  await expect(d.getByRole('navigation', { name: 'Workspaces' }).getByRole('button', { name: new RegExp(`^${mainName}`) })).toHaveCount(0);

  for (const list of errors) expect(list).toEqual([]);
});

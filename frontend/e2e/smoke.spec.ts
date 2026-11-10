import { expect, test } from '@playwright/test';
import { apiAs, createWorkspace, logIn, newUser, sendMessage, signUp, tokenOf, trackPageErrors, workspaceIdFrom } from './helpers';

/**
 * F1 browser smoke tests against a real backend + scratch database.
 * Covers the login-to-workspace flow, workspace switching, live workspace
 * updates, and the existing chat / unread / search / DM / call features.
 */

test('sign up, create a workspace, post, sign out and log back in to the same workspace', async ({ page }) => {
  const errors = trackPageErrors(page);
  const user = newUser('solo');
  await signUp(page, user);
  // P2: every account starts in SmartConnect Collab (there is no "no workspace" screen any more).
  await expect(page.getByRole('navigation', { name: 'Workspaces' }).getByRole('group', { name: 'SmartConnect Collab' })).toBeVisible();
  const workspaceId = await createWorkspace(page, `Smoke HQ ${user.username}`);
  await expect(page.locator('main h2').filter({ hasText: 'General' })).toBeVisible();

  const text = `hello from ${user.username}`;
  await sendMessage(page, text);
  await expect(page.locator('main').getByText(text)).toBeVisible();

  await page.getByTitle('Sign out').click();
  await page.waitForURL(/\/login/);
  await logIn(page, user);
  await page.waitForURL(new RegExp(`/${workspaceId}/c/[0-9a-f-]{36}$`));
  await expect(page.locator('main').getByText(text)).toBeVisible();
  expect(errors).toEqual([]);
});

test('workspace switching and live rename from the shared workspace store', async ({ page, request }) => {
  const errors = trackPageErrors(page);
  const user = newUser('switch');
  await signUp(page, user);
  const first = await createWorkspace(page, `Alpha ${user.username}`);

  await page.getByRole('button', { name: 'Create a workspace' }).click();
  const second = await createWorkspace(page, `Beta ${user.username}`);
  expect(second).not.toBe(first);

  const workspaces = page.getByRole('navigation', { name: 'Workspaces' });
  const rail = (name: string) => workspaces.getByRole('button', { name: new RegExp(`^${name} ${user.username}`) });
  await expect(rail('Alpha')).toBeVisible();
  await expect(rail('Beta')).toHaveAttribute('aria-current', 'page');

  await rail('Alpha').click();
  await page.waitForURL(new RegExp(`/${first}(/|$)`));
  await expect(rail('Alpha')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByText(`Alpha ${user.username}`, { exact: true }).first()).toBeVisible();

  // Live update: a rename made elsewhere (here: the API) reaches the open UI without a reload.
  const token = await tokenOf(page);
  const renamed = `Renamed ${user.username}`;
  const res = await apiAs(request, token).patch(`/api/workspaces/${first}`, { name: renamed });
  expect(res.ok()).toBeTruthy();
  await expect(workspaces.getByRole('button', { name: new RegExp(`^${renamed}`) })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByText(renamed, { exact: true }).first()).toBeVisible();

  await rail('Beta').click();
  await page.waitForURL(new RegExp(`/${second}(/|$)`));

  // Deleting the open workspace lands in another one — never bounces back into
  // the deleted workspace (the shared list drops it before navigating).
  await page.getByRole('button', { name: new RegExp(`^Beta ${user.username} options$`) }).click();
  await page.getByRole('button', { name: 'Delete Workspace' }).click();
  // F2: the accessible dialog requires typing the workspace name first.
  const dialog = page.getByRole('dialog', { name: `Delete "Beta ${user.username}"?` });
  await expect(dialog.getByRole('button', { name: 'Delete Workspace' })).toBeDisabled();
  await dialog.getByLabel(`Type "Beta ${user.username}" to confirm`).fill(`Beta ${user.username}`);
  await dialog.getByRole('button', { name: 'Delete Workspace' }).click(); // confirm in the modal
  await page.waitForURL(new RegExp(`/${first}(/|$)`));
  await expect(rail('Beta')).toHaveCount(0);
  await expect(workspaces.getByRole('button', { name: new RegExp(`^${renamed}`) })).toHaveAttribute('aria-current', 'page');
  expect(errors).toEqual([]);
});

test('two people: live chat, unread badge, in-channel search, DM placement and a call', async ({ browser, request }) => {
  const ctxA = await browser.newContext({ permissions: ['microphone', 'camera'] });
  const ctxB = await browser.newContext({ permissions: ['microphone', 'camera'] });
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();
  const errorsA = trackPageErrors(a);
  const errorsB = trackPageErrors(b);
  const alice = newUser('alice');
  const bob = newUser('bob');

  await signUp(a, alice);
  const workspaceId = await createWorkspace(a, `Team ${alice.username}`);
  const generalUrl = new URL(a.url()).pathname;
  await signUp(b, bob);
  // P2: every account starts in SmartConnect Collab (there is no "no workspace" screen any more).
  await expect(b.getByRole('navigation', { name: 'Workspaces' }).getByRole('group', { name: 'SmartConnect Collab' })).toBeVisible();

  // Setup through the existing invite-link + approval API (the UI is what's under test below).
  const apiA = apiAs(request, await tokenOf(a));
  const apiB = apiAs(request, await tokenOf(b));
  const link = await (await apiA.get(`/api/workspaces/${workspaceId}/invite-link`)).json();
  const joinToken = new URL(link.url).searchParams.get('token');
  expect((await (await apiB.post('/api/workspaces/join', { token: joinToken })).json()).status).toBe('pending');
  const requests = await (await apiA.get(`/api/workspaces/${workspaceId}/requests`)).json();
  const mine = requests.find((r: { user: { username: string } }) => r.user.username === bob.username);
  expect((await apiA.put(`/api/workspaces/${workspaceId}/requests/${mine.id}`, { action: 'APPROVE' })).ok()).toBeTruthy();

  // Bob lands in the workspace's General channel (P2: opened directly — "/" now returns him to Collab, his last active workspace).
  await b.goto(`/${workspaceId}`);
  await b.waitForURL(new RegExp(`/${workspaceId}/c/[0-9a-f-]{36}$`));
  expect(new URL(b.url()).pathname).toBe(generalUrl);

  // Management entry points follow server capabilities: owner yes, plain member no.
  await expect(a.getByRole('button', { name: /Invite People/ })).toBeVisible();
  await expect(b.getByRole('button', { name: /Invite People/ })).toHaveCount(0);
  await b.goto(`/${workspaceId}/directory`);
  await expect(b.locator('main').getByRole('button', { name: 'Channels', exact: true })).toBeVisible();
  await expect(b.locator('main').getByRole('button', { name: /^Join Requests/ })).toHaveCount(0);
  await expect(b.locator('main').getByRole('button', { name: /^Invitations/ })).toHaveCount(0);
  await expect(b.locator('main').getByRole('button', { name: /^(User Groups|External)$/ })).toHaveCount(0);
  await b.goto(generalUrl);

  // Live chat.
  const hello = `hello team ${Date.now()}`;
  await sendMessage(a, hello);
  await expect(b.locator('main').getByText(hello)).toBeVisible();

  // Unread: Bob looks at Home; Alice posts in General → badge on General.
  await b.goto(`/${workspaceId}/home`);
  const ping = `ping ${Date.now()}`;
  await sendMessage(a, ping);
  const bobGeneral = b.getByRole('group', { name: 'Channels' }).getByRole('button', { name: /General/ });
  // A badge appears (exact count depends on how far Bob had read before leaving)…
  await expect(bobGeneral).toHaveText(/^General\s*\d+$/);
  await bobGeneral.click();
  await expect(b.locator('main').getByText(ping)).toBeVisible();
  // …and clears once he opens the channel.
  await expect(bobGeneral).toHaveText(/^General$/);

  // Header search scoped to the open channel → jump to the message.
  const search = a.getByRole('combobox', { name: 'Search messages in #General' });
  await search.fill('hello team');
  const option = a.getByRole('listbox').getByRole('option').filter({ hasText: hello });
  await expect(option).toBeVisible();
  await option.click();
  await expect(a.locator('[data-message-id]').filter({ hasText: hello })).toHaveClass(/ring-2/);

  // DM via People: appears under Direct messages, never under Channels (old verify_dm_fix.mjs, now asserted).
  await a.getByRole('button', { name: 'People', exact: true }).first().click();
  // P3: the People item opens the directory's People tab directly.
  await a.waitForURL(/\/directory\?tab=People$/);
  await a.locator('main').getByRole('button', { name: 'People', exact: true }).click();
  await a.getByRole('button', { name: `View profile of ${bob.username}` }).click();
  await a.getByRole('dialog').getByRole('button', { name: 'Message' }).click();
  await a.waitForURL(/\/c\/[0-9a-f-]{36}$/);
  const dmText = `hi bob ${Date.now()}`;
  await sendMessage(a, dmText);
  await expect(a.getByRole('group', { name: 'Direct messages' })).toContainText(bob.username);
  await expect(a.getByRole('group', { name: 'Channels' })).not.toContainText(bob.username);
  const bobsDm = b.getByRole('group', { name: 'Direct messages' }).getByText(alice.username);
  await expect(bobsDm).toBeVisible();
  await bobsDm.click();
  await expect(b.locator('main').getByText(dmText)).toBeVisible();

  // Calling: Alice rings Bob from the DM; Bob sees the incoming call and accepts.
  await a.getByTitle('Start audio call').click();
  await expect(b.getByText(/Incoming audio call/)).toBeVisible();
  await b.getByRole('button', { name: /Accept/ }).click();
  await expect(b.getByTitle('End call')).toBeVisible();
  await expect(a.getByTitle('End call')).toBeVisible();
  await a.getByTitle('End call').click();

  expect(errorsA).toEqual([]);
  expect(errorsB).toEqual([]);
  await ctxA.close();
  await ctxB.close();
});

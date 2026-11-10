import { Browser, expect, Page, test } from '@playwright/test';
import { apiAs, logIn, makeTeamLead, newUser, signUp, tokenOf, trackPageErrors } from './helpers';

/**
 * Stage 3 (T.22), end to end in real browsers: a Team Lead runs their own
 * workspace — creates it (with a description) from My Workspaces, provisions a
 * new Member who activates once and lands in exactly SmartConnect Collab and
 * that workspace, adds an existing account directly instead of duplicating
 * it, and revokes a pending invitation. The Member sees no management controls.
 */
const freshPage = async (browser: Browser) => (await browser.newContext()).newPage();
const UUID = '[0-9a-f-]{36}';

const readCredentials = async (page: Page) => {
  const shown = page.getByRole('dialog', { name: 'Member invitation' });
  await expect(shown.getByText(/only time/i)).toBeVisible();
  const values = shown.locator('code');
  const credentials = {
    activationUrl: (await values.nth(0).textContent())!.trim(),
    loginId: (await values.nth(1).textContent())!.trim(),
    temporaryPassword: (await values.nth(2).textContent())!.trim(),
  };
  await shown.getByRole('button', { name: 'Done' }).click();
  await expect(shown).toHaveCount(0);
  return credentials;
};

const addTeamMember = async (page: Page, email: string, displayName: string) => {
  await page.getByRole('button', { name: 'Add team member' }).click();
  const form = page.getByRole('dialog', { name: 'Add team member' });
  await form.getByLabel('E-mail address').fill(email);
  await form.getByLabel('Display name (optional)').fill(displayName);
  await form.getByRole('button', { name: 'Create member' }).click();
  return form;
};

test('Stage 3: a Team Lead runs a workspace — create, provision a member who activates into it, add an existing account, revoke', async ({ browser, request }) => {
  test.setTimeout(180_000);
  const run = Date.now().toString(36);
  const lead = newUser('s3lead');
  const page = await freshPage(browser);
  const errors = trackPageErrors(page);
  let workspaceId = '';
  const workspaceName = `Design ${run}`;

  await test.step('1. the Team Lead creates a workspace with a description from My Workspaces', async () => {
    await signUp(page, lead);
    await page.waitForURL(new RegExp(`/${UUID}/`));
    makeTeamLead(lead.email);
    await page.reload();
    await page.getByRole('button', { name: /My Workspaces/ }).click();
    await expect(page.getByRole('heading', { name: 'My Workspaces' })).toBeVisible();
    await page.getByRole('button', { name: 'Create workspace' }).click();
    const dialog = page.getByRole('dialog', { name: 'Create a workspace' });
    await dialog.getByPlaceholder('Acme Corp').fill(workspaceName);
    await dialog.getByLabel('Description (optional)').fill('Where the design team works');
    await dialog.getByRole('button', { name: 'Create Workspace' }).click();
    await page.waitForURL(/\/[0-9a-f-]{36}\/c\/[0-9a-f-]{36}$/);
    workspaceId = new URL(page.url()).pathname.split('/')[1];
    await page.goto(`/${workspaceId}/my-workspaces`);
    const card = page.getByRole('article', { name: workspaceName });
    await expect(card.getByText('Where the design team works')).toBeVisible();
    await expect(card.getByText('1 member')).toBeVisible();
    await card.getByRole('link', { name: `Manage ${workspaceName}` }).click();
    await expect(page.getByRole('button', { name: 'Add team member' })).toBeVisible();
  });

  const memberEmail = `e2e_s3member_${run}@example.test`;
  let credentials = { activationUrl: '', loginId: '', temporaryPassword: '' };
  await test.step('2. the lead provisions a new member; credentials are shown once; activation is pending', async () => {
    await addTeamMember(page, memberEmail, `Mia ${run}`);
    credentials = await readCredentials(page);
    expect(credentials.loginId).toBe(memberEmail);
    const row = page.getByRole('region', { name: 'Member activations' }).getByRole('listitem').filter({ hasText: `Mia ${run}` });
    await expect(row.getByText('Pending', { exact: true })).toBeVisible();
    await expect(row.getByText('Awaiting activation', { exact: true })).toBeVisible();
  });

  const member = await freshPage(browser);
  const memberErrors = trackPageErrors(member);
  const newPassword = `Member-own-password-${run}`;
  await test.step('3. the member activates once and lands in exactly SmartConnect Collab and the team workspace', async () => {
    await member.goto(credentials.activationUrl);
    await member.getByLabel('Temporary password').fill(credentials.temporaryPassword);
    await member.getByLabel('New password', { exact: true }).fill(newPassword);
    await member.getByLabel('Confirm new password').fill(newPassword);
    await member.getByRole('button', { name: 'Activate account' }).click();
    await expect(member.getByRole('heading', { name: 'Your account is ready' })).toBeVisible();
    await member.getByRole('link', { name: 'Go to sign in' }).click();
    await logIn(member, { username: 'x', email: memberEmail, password: newPassword });
    await member.waitForURL(new RegExp(`/${UUID}/`));
    const workspaces = (await (await apiAs(request, await tokenOf(member)).get('/api/workspaces')).json()) as { id: string; isDefault?: boolean }[];
    expect(workspaces).toHaveLength(2);
    expect(workspaces.some((w) => w.isDefault)).toBe(true);
    expect(workspaces.map((w) => w.id)).toContain(workspaceId);
  });

  await test.step('4. the member sees no management controls, and the server refuses them anyway', async () => {
    await expect(member.getByRole('navigation', { name: 'Workspaces' }).getByRole('button', { name: 'Create a workspace' })).toHaveCount(0);
    await expect(member.getByRole('button', { name: /My Workspaces/ })).toHaveCount(0);
    await member.goto(`/${workspaceId}/settings?tab=members`);
    await expect(member.getByRole('searchbox', { name: 'Search members' })).toBeVisible();
    await expect(member.getByRole('button', { name: 'Add team member' })).toHaveCount(0);
    await expect(member.getByRole('button', { name: 'Add people' })).toHaveCount(0);
    const api = apiAs(request, await tokenOf(member));
    expect((await api.post(`/api/workspaces/${workspaceId}/member-invitations`, { email: `x_${run}@example.test` })).status()).toBe(403);
    expect((await api.post('/api/workspaces', { name: `Nope ${run}` })).status()).toBe(403);
  });

  await test.step('5. an existing account is added directly — never a second account', async () => {
    const existing = newUser('s3existing');
    const other = await freshPage(browser);
    await signUp(other, existing);
    await other.waitForURL(new RegExp(`/${UUID}/`));
    await other.context().close();
    const form = await addTeamMember(page, existing.email, 'Existing person');
    await expect(form.getByText(/already has an account/)).toBeVisible();
    await form.getByRole('button', { name: new RegExp(`^Add .* to ${workspaceName}$`) }).click();
    await expect(form).toHaveCount(0);
    const members = await (await apiAs(request, await tokenOf(page)).get(`/api/workspaces/${workspaceId}/members?q=${existing.username}`)).json();
    expect(JSON.stringify(members)).toContain(existing.username);
  });

  await test.step('6. the lead revokes a pending invitation', async () => {
    const pendingName = `Omar ${run}`;
    await addTeamMember(page, `e2e_s3pending_${run}@example.test`, pendingName);
    await readCredentials(page);
    const row = page.getByRole('region', { name: 'Member activations' }).getByRole('listitem').filter({ hasText: pendingName });
    await row.getByRole('button', { name: `Revoke invitation for ${pendingName}` }).click();
    await page.getByRole('dialog', { name: 'Revoke invitation?' }).getByRole('button', { name: 'Revoke' }).click();
    await expect(row.getByText('Revoked', { exact: true })).toBeVisible();
    // The activated member shows as Accepted / Active.
    await page.reload();
    const activated = page.getByRole('region', { name: 'Member activations' }).getByRole('listitem').filter({ hasText: `Mia ${run}` });
    await expect(activated.getByText('Accepted', { exact: true })).toBeVisible();
    await expect(activated.getByText('Active', { exact: true })).toBeVisible();
  });

  expect(errors).toEqual([]);
  expect(memberErrors).toEqual([]);
});

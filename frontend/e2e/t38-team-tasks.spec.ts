import { expect, Page, test } from '@playwright/test';
import { apiAs, createWorkspace, logIn, newUser, pageToken, signUp, trackPageErrors } from './helpers';

/**
 * T.38 — Team Lead → member task assignment, in ONE browser profile with four
 * tabs, each with its own T.37 development tab sign-in: Team Lead, Sahil,
 * Developer 2, Developer 3. Socket.IO frames are recorded per tab to show who
 * received which task events.
 */
const userIdOf = (jwt: string) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString()).id as string;
const frameText = (payload: string | Buffer) => (typeof payload === 'string' ? payload : payload.toString('utf8'));
const framesOf = (page: Page) => {
  const frames: string[] = [];
  page.on('websocket', (ws) => ws.on('framereceived', (f) => frames.push(frameText(f.payload))));
  return frames;
};
const panel = (page: Page) => page.getByRole('region', { name: 'Development tab sign-in' });

test('Team Lead assigns 5/3/2 tasks; each member sees only theirs; progress updates live; access is enforced', async ({ browser, request }) => {
  const context = await browser.newContext(); // one profile, four tabs
  const run = Date.now().toString(36);
  const users = { lead: newUser('t38lead'), sahil: newUser('sahil'), dev2: newUser('t38dev2'), dev3: newUser('t38dev3') };
  type Key = keyof typeof users;
  const keys = Object.keys(users) as Key[];
  const tabs = {} as Record<Key, Page>;
  const frames = {} as Record<Key, string[]>;
  const errors = {} as Record<Key, string[]>;
  for (const k of keys) {
    tabs[k] = await context.newPage();
    frames[k] = framesOf(tabs[k]);
    errors[k] = trackPageErrors(tabs[k]);
  }
  const ids = {} as Record<Key, string>;
  const token = async (k: Key) => (await pageToken(tabs[k]))!;
  const titles = {
    sahil: [1, 2, 3, 4, 5].map((i) => `Sahil task ${i} ${run}`),
    dev2: [1, 2, 3].map((i) => `Dev2 task ${i} ${run}`),
    dev3: [1, 2].map((i) => `Dev3 task ${i} ${run}`),
  };
  let workspaceId = '';

  await test.step('setup: four tab sign-ins; the lead’s workspace with Sahil, Developer 2 and Developer 3', async () => {
    for (const k of keys) {
      await tabs[k].goto('/login?tabSession=1');
      await signUp(tabs[k], users[k]);
      await expect(panel(tabs[k])).toContainText(`This tab: ${users[k].username}`);
      ids[k] = userIdOf(await token(k));
    }
    workspaceId = await createWorkspace(tabs.lead, `SmartUnifolio ${run}`);
    const lead = apiAs(request, await token('lead'));
    for (const k of ['sahil', 'dev2', 'dev3'] as const) expect((await lead.post(`/api/workspaces/${workspaceId}/members`, { userId: ids[k] })).status()).toBe(201);
  });

  await test.step('1–4. Team Lead opens Team Tasks and creates 5 + 3 + 2 tasks, one after another', async () => {
    const lead = tabs.lead;
    await lead.reload();
    await lead.getByRole('button', { name: 'Team Tasks' }).click();
    await lead.waitForURL(new RegExp(`/${workspaceId}/team-tasks$`));
    await expect(lead.getByRole('heading', { level: 1, name: 'Team tasks' })).toBeVisible();
    await expect(lead.getByRole('button', { name: 'Total tasks: 0' })).toBeVisible();
    await lead.getByRole('button', { name: 'Create task' }).first().click();
    const dialog = lead.getByRole('dialog', { name: 'Create task' });
    for (const k of ['sahil', 'dev2', 'dev3'] as const) {
      await dialog.getByLabel('Assign to').selectOption({ label: users[k].username });
      for (const [i, title] of titles[k].entries()) {
        await dialog.getByLabel('Task title').fill(title);
        if (i === 0) await dialog.getByLabel('Priority').selectOption('HIGH');
        await dialog.getByRole('button', { name: 'Assign task' }).click();
        await expect(dialog.getByRole('status')).toContainText(`Assigned “${title}” to ${users[k].username}.`);
        await expect(dialog.getByLabel('Task title')).toHaveValue('');
      }
    }
    await dialog.getByRole('button', { name: 'Done' }).click();
    // 8. The lead sees all ten, and each member's 0/N.
    await expect(lead.getByRole('button', { name: 'Total tasks: 10' })).toBeVisible();
    await expect(lead.getByRole('table', { name: 'Team tasks' }).getByRole('row')).toHaveCount(11); // header + 10
    await expect(lead.getByRole('button', { name: new RegExp(`^${users.sahil.username}: 0 of 5 completed \\(0%\\)`) })).toBeVisible();
    await expect(lead.getByRole('button', { name: new RegExp(`^${users.dev2.username}: 0 of 3 completed`) })).toBeVisible();
    await expect(lead.getByRole('button', { name: new RegExp(`^${users.dev3.username}: 0 of 2 completed`) })).toBeVisible();
  });

  const myList = (k: Key) => tabs[k].getByRole('list', { name: 'My tasks' });
  await test.step('5–7. each member sees exactly their own tasks', async () => {
    for (const [k, n] of [['sahil', 5], ['dev2', 3], ['dev3', 2]] as const) {
      await tabs[k].goto(`/${workspaceId}/tasks`);
      await expect(tabs[k].getByRole('tab', { name: /My tasks/ })).toContainText(String(n));
      await expect(myList(k).getByRole('listitem')).toHaveCount(n);
      for (const title of titles[k]) await expect(myList(k).getByText(title)).toBeVisible();
      for (const other of (['sahil', 'dev2', 'dev3'] as const).filter((o) => o !== k)) {
        for (const title of titles[other]) await expect(tabs[k].getByText(title)).toHaveCount(0);
      }
      // Members get no Team Tasks entry, and the page refuses them.
      await expect(tabs[k].getByRole('button', { name: 'Team Tasks' })).toHaveCount(0);
    }
    await tabs.dev2.goto(`/${workspaceId}/team-tasks`);
    await expect(tabs.dev2.getByText('Team tasks are for Team Leads')).toBeVisible();
    await tabs.dev2.goto(`/${workspaceId}/tasks`);
  });

  const first = titles.sahil[0];
  await test.step('9–10. Sahil starts his first task; the lead sees it live', async () => {
    await tabs.sahil.getByRole('button', { name: `Start ${first}` }).click();
    await expect(tabs.lead.getByRole('button', { name: 'In progress: 1' })).toBeVisible();
    await expect(tabs.lead.getByRole('button', { name: new RegExp(`^${users.sahil.username}: 0 of 5 completed \\(0%\\), 1 in progress`) })).toBeVisible();
  });

  await test.step('11–12. Sahil completes it (with confirmation); the lead sees 1/5 live', async () => {
    await tabs.sahil.getByRole('button', { name: `Mark ${first} as completed` }).click();
    await tabs.sahil.getByRole('dialog', { name: 'Mark this task as completed?' }).getByRole('button', { name: 'Mark completed' }).click();
    await expect(tabs.sahil.getByRole('tab', { name: /Completed/ })).toContainText('1');
    await expect(tabs.lead.getByRole('button', { name: 'Completed: 1' })).toBeVisible();
    await expect(tabs.lead.getByRole('button', { name: new RegExp(`^${users.sahil.username}: 1 of 5 completed \\(20%\\)`) })).toBeVisible();
    await tabs.sahil.getByRole('tab', { name: /Completed/ }).click();
    await expect(tabs.sahil.getByRole('list', { name: 'Completed' }).getByText(/Completed [A-Z][a-z]{2} \d+, \d+:\d\d (AM|PM)/)).toBeVisible();
  });

  await test.step('13. the other developers never received Sahil’s task events', async () => {
    expect(frames.lead.some((f) => f.includes(first))).toBe(true); // positive control
    expect(frames.sahil.some((f) => f.includes(first))).toBe(true);
    for (const k of ['dev2', 'dev3'] as const) for (const title of titles.sahil) expect(frames[k].some((f) => f.includes(title)), `${k} got "${title}"`).toBe(false);
  });

  await test.step('14. direct API access to Sahil’s task by Developer 2 is denied', async () => {
    const lead = apiAs(request, await token('lead'));
    const sahilTasks = (await (await lead.get(`/api/workspaces/${workspaceId}/team-tasks?assigneeId=${ids.sahil}`)).json()).tasks as { id: string }[];
    expect(sahilTasks).toHaveLength(5);
    const dev2 = apiAs(request, await token('dev2'));
    const target = sahilTasks[0].id;
    expect((await dev2.get(`/api/tasks/${target}`)).status()).toBe(404);
    expect((await dev2.patch(`/api/tasks/${target}`, { status: 'DONE' })).status()).toBe(404);
    expect((await dev2.get(`/api/tasks/${target}/comments`)).status()).toBe(404);
    expect((await dev2.get(`/api/workspaces/${workspaceId}/team-tasks/summary`)).status()).toBe(403);
    expect((await dev2.post(`/api/workspaces/${workspaceId}/team-tasks`, { title: 'x', assigneeId: ids.dev3 })).status()).toBe(403);
    expect(JSON.stringify(await (await dev2.get(`/api/workspaces/${workspaceId}/search/all?q=Sahil`)).json())).not.toContain('Sahil task');
    // Sahil himself may change status but not edit or reassign.
    const sahil = apiAs(request, await token('sahil'));
    expect((await sahil.patch(`/api/tasks/${target}`, { title: 'Renamed' })).status()).toBe(403);
    expect((await sahil.patch(`/api/tasks/${target}`, { assigneeId: ids.dev2 })).status()).toBe(403);
  });

  await test.step('15. counts are the same after a refresh and after signing in again', async () => {
    await tabs.lead.reload();
    await expect(tabs.lead.getByRole('button', { name: 'Total tasks: 10' })).toBeVisible();
    await expect(tabs.lead.getByRole('button', { name: new RegExp(`^${users.sahil.username}: 1 of 5 completed \\(20%\\)`) })).toBeVisible();
    // Sahil signs out and back in, in his own tab.
    await tabs.sahil.goto(`/${workspaceId}`);
    await tabs.sahil.getByRole('button', { name: 'Sign out' }).first().click();
    await tabs.sahil.waitForURL(/\/login/);
    await logIn(tabs.sahil, users.sahil);
    await expect(panel(tabs.sahil)).toContainText(`This tab: ${users.sahil.username}`);
    await tabs.sahil.goto(`/${workspaceId}/tasks`);
    await expect(tabs.sahil.getByRole('tab', { name: /My tasks/ })).toContainText('4');
    await expect(tabs.sahil.getByRole('tab', { name: /Completed/ })).toContainText('1');
    for (const [k, n] of [['dev2', 3], ['dev3', 2]] as const) {
      await tabs[k].reload();
      await expect(myList(k).getByRole('listitem')).toHaveCount(n);
    }
  });

  await test.step('16. workspace boundary: a user outside the workspace gets nothing', async () => {
    const outsider = await context.newPage();
    const outsiderUser = newUser('t38out');
    await outsider.goto('/login?tabSession=1');
    await signUp(outsider, outsiderUser);
    await expect(panel(outsider)).toContainText(`This tab: ${outsiderUser.username}`); // signed in before reading the token
    const outsiderToken = (await pageToken(outsider))!;
    expect((await apiAs(request, outsiderToken).get('/api/auth/me')).status()).toBe(200);
    const api = apiAs(request, outsiderToken);
    const anyTask = (await (await apiAs(request, await token('lead')).get(`/api/workspaces/${workspaceId}/team-tasks`)).json()).tasks[0].id as string;
    expect((await api.get(`/api/tasks/${anyTask}`)).status()).toBe(404);
    expect((await api.get(`/api/workspaces/${workspaceId}/team-tasks`)).status()).toBe(404);
    expect((await api.get(`/api/workspaces/${workspaceId}/my-tasks`)).status()).toBe(404);
    await outsider.close();
  });

  for (const k of keys) expect(errors[k], `${k} page errors`).toEqual([]);
  await context.close();
});

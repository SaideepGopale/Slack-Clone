import { expect, test } from '@playwright/test';
import { createWorkspace, newUser, signUp, trackPageErrors } from './helpers';

/**
 * T.33 — end-to-end, in a real browser against the real API and a LOCAL
 * throwaway database:
 *  - a Team Lead creates a project, adds tasks from the board, drags a card
 *    to another column, and the move survives a reload;
 *  - the task drawer changes status and posts a comment;
 *  - My Tasks lists an assigned task;
 *  - the ⌘K palette finds the task by identifier and opens it;
 *  - a voice note is recorded (Chromium's fake microphone), paused, resumed,
 *    stopped and reviewed in the composer, then discarded. (Sending uploads
 *    to storage, which E2E has no credentials for; the upload path is
 *    covered by backend tests with a storage stand-in.)
 */
test('projects, board drag-and-drop, task drawer, my tasks and the command palette', async ({ page }) => {
  const errors = trackPageErrors(page);
  const lead = newUser('t33lead');
  await signUp(page, lead);
  const workspaceId = await createWorkspace(page, `T33 ${Date.now()}`);

  // Projects from the sidebar.
  await page.getByRole('button', { name: 'Projects' }).first().click();
  await expect(page).toHaveURL(new RegExp(`/${workspaceId}/projects$`));
  await page.getByRole('button', { name: 'New project' }).first().click();
  await page.getByLabel('Name').fill('Launch plan');
  await page.getByLabel('Key').fill('LCH');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.waitForURL(new RegExp(`/${workspaceId}/projects/[0-9a-f-]{36}`));
  const projectUrl = new URL(page.url()).pathname;

  // Quick-add two tasks to "To do".
  const todo = page.getByRole('listitem', { name: /^To do column/ });
  for (const title of ['Draft announcement', 'Book venue']) {
    const input = page.getByLabel('New task in To do');
    // The quick-add box stays open after each task (rapid entry).
    if (!(await input.isVisible())) await todo.getByRole('button', { name: 'Add task' }).click();
    await input.fill(title);
    await input.press('Enter');
    await expect(page.getByRole('button', { name: new RegExp(`LCH-\\d+: ${title}`) })).toBeVisible();
  }

  // Drag "Book venue" into "In progress".
  const card = page.getByRole('button', { name: /LCH-\d+: Book venue/ });
  const inProgress = page.getByRole('listitem', { name: /^In progress column/ });
  await card.dragTo(inProgress);
  await expect(page.getByRole('listitem', { name: /^In progress column, 1 task/ })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('listitem', { name: /^In progress column, 1 task/ }).getByRole('button', { name: /Book venue/ })).toBeVisible();

  // Task drawer: change status from its menu, add a comment.
  await page.getByRole('button', { name: /LCH-\d+: Draft announcement/ }).click();
  await expect(page).toHaveURL(/\?(.*&)?task=/);
  const drawer = page.getByRole('dialog');
  await drawer.getByRole('combobox', { name: 'Status' }).selectOption('IN_REVIEW');
  await expect(page.getByRole('listitem', { name: /^In review column, 1 task/ })).toBeVisible();
  await drawer.getByRole('textbox', { name: 'Write a comment' }).fill('Ready for a look');
  await drawer.getByRole('textbox', { name: 'Write a comment' }).press('Control+Enter');
  await expect(drawer.getByText('Ready for a look')).toBeVisible();
  await drawer.getByRole('combobox', { name: 'Assignee' }).selectOption({ label: lead.username });
  await page.keyboard.press('Escape');

  // My Tasks shows it.
  await page.getByRole('button', { name: 'My Tasks' }).first().click();
  await expect(page).toHaveURL(new RegExp(`/${workspaceId}/tasks`));
  await expect(page.getByText('Draft announcement')).toBeVisible();

  // ⌘K palette: find by identifier, open it on its board.
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('combobox', { name: /Search tasks, projects/ });
  await palette.fill('LCH-1');
  await expect(page.getByRole('option', { name: /LCH-1 Draft announcement/ })).toBeVisible();
  await palette.press('Enter');
  await expect(page).toHaveURL(new RegExp(`${projectUrl}\\?task=`));
  await expect(page.getByRole('dialog').getByText('Ready for a look')).toBeVisible();

  expect(errors).toEqual([]);
});

test('voice note: record, pause, resume, review with the waveform player, discard', async ({ page }) => {
  const errors = trackPageErrors(page);
  await signUp(page, newUser('t33voice'));
  await createWorkspace(page, `T33 voice ${Date.now()}`);

  await page.getByRole('button', { name: 'Record voice message' }).click();
  await expect(page.getByRole('button', { name: 'Pause recording' })).toBeVisible();
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: 'Pause recording' }).click();
  await page.getByRole('button', { name: 'Resume recording' }).click();
  await page.waitForTimeout(800);
  await page.getByRole('button', { name: 'Stop and review voice message' }).click();

  const player = page.getByRole('group', { name: 'Recorded voice message' });
  await expect(player).toBeVisible();
  await expect(player.getByRole('slider', { name: /Seek/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send voice message' })).toBeEnabled();
  await player.getByRole('button', { name: /Playback speed 1×/ }).click();
  await expect(player.getByRole('button', { name: /Playback speed 1.5×/ })).toBeVisible();

  await page.getByRole('button', { name: 'Discard voice message' }).click();
  await expect(page.locator('main [contenteditable="true"]').first()).toBeVisible();
  expect(errors).toEqual([]);
});

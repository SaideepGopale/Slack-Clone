import { APP_URL } from '../../config/env';
import { logAuditEvent } from '../../lib/auditLog';
import { HttpError } from '../../lib/httpError';
import { isUuid, normalizeMessageInput } from '../../lib/messageInput';
import { prisma } from '../../lib/prisma';
import { assertTask, loadProjectActor } from '../../lib/policy';
import { checkChannelContent, getChannelAccess } from '../../sockets/channelAccess';
import { broadcastNewMessage } from '../../sockets/registry';
import { projectKey } from './tasks.views';

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * T.33 — share a task into a conversation as a normal message with a link.
 * The sender must be able to view the task and to post in the channel (same
 * rules as sending any message: membership, archive, announcement). A task of
 * a PRIVATE project may only be shared into that project's own channels, so
 * its title never reaches people outside the project.
 */
export const shareTask = async (userId: string, taskId: string, body: Record<string, unknown> | undefined) => {
  if (!isUuid(taskId)) throw new HttpError(404, 'Task not found.');
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    select: {
      id: true,
      number: true,
      title: true,
      status: true,
      projectId: true,
      workspaceId: true,
      assigneeOnly: true,
      assigneeId: true,
      creatorId: true,
      project: { select: { name: true, key: true, visibility: true } },
    },
  });
  if (!task) throw new HttpError(404, 'Task not found.');
  const actor = await loadProjectActor(userId, task.projectId);
  assertTask(actor, 'task.view', task);
  // T.38: a private assignment never goes into a channel — its title would reach everyone there.
  if (task.assigneeOnly) throw new HttpError(403, 'Private assignments cannot be shared in channels.');

  const channelId = body?.channelId;
  const access = await getChannelAccess(userId, channelId);
  if (!access || access.workspaceId !== task.workspaceId) throw new HttpError(404, 'Conversation not found.');
  const denial = await checkChannelContent(userId, access, 'post');
  if (denial) throw new HttpError(403, denial);
  if (task.project.visibility === 'PRIVATE' && access.projectId !== task.projectId) {
    throw new HttpError(403, 'Tasks of a private project can only be shared in that project’s channels.');
  }
  const note = typeof body?.note === 'string' ? body.note.trim().slice(0, 1000) : '';

  const identifier = `${projectKey(task.project)}-${task.number}`;
  const link = `${APP_URL}/${task.workspaceId}/projects/${task.projectId}?task=${task.id}`;
  const html =
    `<p>📋 <a href="${escapeHtml(link)}">${escapeHtml(`${identifier} · ${task.title}`)}</a> — ${escapeHtml(task.project.name)} · ${task.status.replace('_', ' ').toLowerCase()}</p>` +
    (note ? `<p>${escapeHtml(note)}</p>` : '');
  // The same normalisation/sanitisation as every chat message.
  const parsed = normalizeMessageInput({ channelId: access.channelId, content: html });
  if (!parsed.ok) throw new HttpError(400, parsed.error);

  const message = await prisma.message.create({
    data: { channelId: access.channelId, workspaceId: task.workspaceId, senderId: userId, content: parsed.value.content },
    include: { sender: { select: { id: true, username: true } }, _count: { select: { replies: true } } },
  });
  await prisma.taskActivity.create({ data: { taskId: task.id, actorId: userId, type: 'shared', data: { channelId: access.channelId, channelName: access.name } } });
  broadcastNewMessage(access.channelId, message);
  await logAuditEvent(userId, 'SHARE_TASK', 'TASK', task.id, `Shared ${identifier} to a conversation`);
  return { messageId: message.id };
};

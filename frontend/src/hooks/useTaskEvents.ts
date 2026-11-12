import { useEffect, useRef } from 'react';
import type { Socket } from 'socket.io-client';
import type { TaskView } from '../lib/api/tasks';

/**
 * T.33 — live task events (`task:upserted`, `task:deleted`), delivered by the
 * server to the project's audience only. Handlers are read through a ref, so
 * callers can pass inline functions without re-subscribing every render.
 */
export const useTaskEvents = (
  socket: Socket | null | undefined,
  handlers: { onUpsert?: (task: TaskView) => void; onDelete?: (taskId: string, projectId: string) => void }
) => {
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    if (!socket) return;
    const upsert = (payload: { task?: TaskView }) => {
      if (payload?.task?.id) ref.current.onUpsert?.(payload.task);
    };
    const remove = (payload: { taskId?: string; projectId?: string }) => {
      if (payload?.taskId) ref.current.onDelete?.(payload.taskId, payload.projectId ?? '');
    };
    socket.on('task:upserted', upsert);
    socket.on('task:deleted', remove);
    return () => {
      socket.off('task:upserted', upsert);
      socket.off('task:deleted', remove);
    };
  }, [socket]);
};

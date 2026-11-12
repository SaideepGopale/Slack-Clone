import { runOverdueReminders } from './tasks.service';
import { pushWorkNotifications } from './tasks.realtime';

/**
 * T.33 — overdue reminders every 15 minutes (first run a minute after
 * start). Safe with several instances: each task is claimed atomically
 * (tasks.service runOverdueReminders), so a reminder is sent once.
 */
let timer: NodeJS.Timeout | null = null;
export const startTaskJobs = () => {
  if (timer || process.env.NODE_ENV === 'test') return;
  const run = () =>
    runOverdueReminders()
      .then(pushWorkNotifications)
      .catch((err) => console.error('Overdue reminders failed:', err instanceof Error ? err.message : err));
  setTimeout(run, 60_000).unref();
  timer = setInterval(run, 15 * 60_000);
  timer.unref();
};

export const stopTaskJobs = () => {
  if (timer) clearInterval(timer);
  timer = null;
};

import { createServer } from 'http';
import { app } from './app';
import { PORT } from './config/env';
import { startAttachmentSweeper } from './lib/attachments';
import { isShuttingDown, markShuttingDown } from './lib/lifecycle';
import { prisma } from './lib/prisma';
import { closeRedis, redisEnabled } from './lib/redis';
import { reconcileSharedWorkspace } from './lib/sharedWorkspace';
import { startTaskJobs, stopTaskJobs } from './modules/tasks/tasks.jobs';
import { createSocketServer, stopSocketBackground } from './sockets';

// Safety net, not the primary fix — the real fix is proper try/catch inside
// every async Socket.IO handler (see sockets/*.handlers.ts), since Socket.IO
// does not catch rejected promises from event listeners the way Express
// catches synchronous throws. Without this process-level handler, one
// uncaught rejection anywhere (a transient DB hiccup, an unexpected payload)
// would otherwise crash the entire process for every connected user — Node
// terminates on an unhandled rejection by default since v15.
//
// Deliberately logs and continues rather than exiting: this app has no
// confirmed process supervisor (PM2/systemd/Docker restart policy) to bring
// it back up immediately, so exiting here would just turn "one bad request"
// into "the whole server is down until someone notices and restarts it by
// hand." If a real process manager gets added later, revisit this — exiting
// after logging is the more correct long-term posture once something will
// actually restart the process right away.
process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err);
});

const httpServer = createServer(app);
// T.33: bounded request lifetimes. Slow-loris style clients cannot hold a
// connection open indefinitely; uploads (≤ 25 MB) get two minutes. Keep-alive
// outlives a typical load-balancer idle timeout (60 s) so the balancer, not
// Node, closes idle connections (avoids sporadic 502s).
httpServer.requestTimeout = Number(process.env.HTTP_REQUEST_TIMEOUT_MS) || 120_000;
httpServer.headersTimeout = 20_000;
httpServer.keepAliveTimeout = 65_000;
const io = createSocketServer(httpServer);

/**
 * T.33 graceful shutdown (SIGTERM from Render/Kubernetes/docker, SIGINT
 * locally): readiness turns 503, new connections are refused, sockets are
 * told to reconnect (they land on another instance), in-flight requests
 * finish, then the database and Redis connections close. Forced exit after
 * SHUTDOWN_TIMEOUT_MS so a stuck request cannot block a deploy.
 */
const shutdown = (signal: string) => {
  if (isShuttingDown()) return;
  markShuttingDown();
  console.log(`${signal} received — draining connections.`);
  const forced = setTimeout(() => {
    console.error('Shutdown timed out; exiting.');
    process.exit(1);
  }, Number(process.env.SHUTDOWN_TIMEOUT_MS) || 15_000);
  forced.unref();

  stopSocketBackground();
  stopTaskJobs();
  // io.close() disconnects every socket and closes the HTTP server (no new
  // connections; in-flight requests complete).
  io.close(() => {
    // Let disconnect handlers finish their presence/call clean-up writes.
    setTimeout(async () => {
      await Promise.allSettled([prisma.$disconnect(), redisEnabled() ? closeRedis() : Promise.resolve()]);
      console.log('Shutdown complete.');
      process.exit(0);
    }, 500);
  });
  httpServer.closeIdleConnections();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`Backend running on http://localhost:${PORT}`);
  // P2: create/reconcile the shared SmartConnect Collab workspace and give
  // existing active accounts first-time access. Idempotent and insert-only;
  // a failure is logged, never fatal (accounts also get access lazily when
  // they next load their workspace list).
  // T.32 (audit M10/M9): destroys uploads never sent, and files left behind
  // by channel/workspace deletions (after a 24-hour grace period).
  startAttachmentSweeper();
  // T.33: overdue task reminders.
  startTaskJobs();
  reconcileSharedWorkspace()
    .then((r) => console.log(`SmartConnect Collab ready (${r.channelIds.length} channels; ${r.membersAdded} member(s) added).`))
    .catch((err) => console.error('SmartConnect Collab reconcile failed:', err));
});

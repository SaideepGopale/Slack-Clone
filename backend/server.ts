import { createServer } from 'http';
import { app } from './app';
import { PORT } from './config/env';
import { createSocketServer } from './sockets';

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
createSocketServer(httpServer);

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`Backend running on http://localhost:${PORT}`);
});

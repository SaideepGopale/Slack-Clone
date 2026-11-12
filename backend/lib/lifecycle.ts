/**
 * Process lifecycle flags (T.33). While shutting down, the readiness probe
 * answers 503 so a load balancer stops sending new traffic to this instance
 * before its connections are closed.
 */
let shuttingDown = false;

export const isShuttingDown = () => shuttingDown;
export const markShuttingDown = () => {
  shuttingDown = true;
};

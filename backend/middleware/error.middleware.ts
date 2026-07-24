import { Request, Response, NextFunction } from 'express';

export const errorHandler = (err: any, _req: Request, res: Response, _next: NextFunction) => {
  const status = err.status || 500;
  // Only log a stack trace for genuinely unexpected failures. 4xx errors
  // (bad input, unauthorized, not found, ...) are the normal outcome of
  // request validation — logging a full trace for every one of them buries
  // real 5xx bugs in noise. A one-line log still records that a 4xx
  // happened, without looking like a crash.
  if (status >= 500) {
    console.error(err);
  } else {
    console.log(`[${status}] ${err.message}`);
  }
  res.status(status).json({ error: err.message || 'Internal Server Error' });
};

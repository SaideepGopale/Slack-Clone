import { Request, Response, NextFunction } from 'express';
import { Prisma } from '@prisma/client';

/**
 * T.32 (audit M3): turns errors into consistent JSON without leaking
 * internals. Errors thrown deliberately with a status (HttpError and the
 * per-service copies, body-parser, CORS) keep their message — those messages
 * are written for users. Anything unexpected becomes a generic 500 (the
 * detail goes to the server log only), and well-known database outcomes get
 * the status they really mean instead of a 500 carrying Prisma's text:
 *   P2002 unique violation → 409, P2025 record not found → 404,
 *   P2003 foreign-key violation → 409, invalid query input → 400.
 *
 * T.34: an unreachable database (Postgres down, connection lost, pool
 * exhausted) is a temporary outage, not a bug: 503 with Retry-After and a
 * message that says so. Before this, a stopped database container made every
 * login answer 500 "Something went wrong on our side".
 */
const GENERIC_500 = 'Something went wrong on our side. Please try again.';
const UNAVAILABLE = 'SmartConnect is temporarily unavailable. Please try again in a moment.';
const RETRY_AFTER_SECONDS = '5';
// P1001 can't reach server, P1002 reached but timed out, P1008 operation
// timed out, P1017 server closed the connection, P2024 connection-pool timeout.
const UNAVAILABLE_CODES = new Set(['P1001', 'P1002', 'P1008', 'P1017', 'P2024']);

const prismaStatus = (err: unknown): { status: number; message: string } | null => {
  // Prisma throws this when it cannot connect at all (it carries no code then).
  if (err instanceof Prisma.PrismaClientInitializationError) return { status: 503, message: UNAVAILABLE };
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (UNAVAILABLE_CODES.has(err.code)) return { status: 503, message: UNAVAILABLE };
    switch (err.code) {
      case 'P2002':
        return { status: 409, message: 'This already exists. Refresh and try again.' };
      case 'P2025':
        return { status: 404, message: 'Not found.' };
      case 'P2003':
        return { status: 409, message: 'This item is linked to something that no longer exists. Refresh and try again.' };
      case 'P2000':
        return { status: 400, message: 'A value is too long.' };
      case 'P2023':
        return { status: 400, message: 'Invalid identifier.' };
      default:
        return null;
    }
  }
  if (err instanceof Prisma.PrismaClientValidationError) return { status: 400, message: 'Invalid request.' };
  return null;
};

export const errorHandler = (err: any, _req: Request, res: Response, _next: NextFunction) => {
  const mapped = prismaStatus(err);
  const explicit = typeof err?.status === 'number' ? err.status : typeof err?.statusCode === 'number' ? err.statusCode : null;
  const status = mapped?.status ?? explicit ?? 500;
  // body-parser errors carry a status but a parser message; give a clean one.
  const bodyParserMessage =
    err?.type === 'entity.parse.failed' ? 'The request body is not valid JSON.' : err?.type === 'entity.too.large' ? 'The request body is too large.' : null;
  const message = mapped?.message ?? bodyParserMessage ?? (explicit !== null && typeof err?.message === 'string' && err.message ? err.message : GENERIC_500);

  // Only log a stack trace for genuinely unexpected failures. 4xx errors
  // (bad input, unauthorized, not found, ...) are the normal outcome of
  // request validation — logging a full trace for every one of them buries
  // real 5xx bugs in noise. A one-line log still records that a 4xx
  // happened, without looking like a crash.
  if (status >= 500) {
    console.error(err);
  } else {
    console.log(`[${status}] ${mapped ? `${err.code ?? 'prisma'}: ${message}` : err?.message ?? message}`);
  }
  if (res.headersSent) return;
  if (status === 503 && mapped) res.setHeader('Retry-After', RETRY_AFTER_SECONDS);
  res.status(status).json({ error: message });
};

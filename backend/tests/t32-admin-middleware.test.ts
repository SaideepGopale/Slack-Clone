import { describe, expect, it, vi } from 'vitest';

// Unit test with a failing database: requireAdmin must hand the error to
// Express (→ errorHandler → clean 500) instead of leaving the request hanging
// as an unhandled rejection (T.32, audit M2).
vi.mock('../lib/prisma', () => ({
  prisma: { $disconnect: vi.fn(), user: { findUnique: vi.fn().mockRejectedValue(new Error('database unavailable')) } },
}));

import { requireAdmin } from '../middleware/admin.middleware';

describe('T.32 M2 — requireAdmin error path', () => {
  it('passes a database failure to next(err) and sends nothing itself', async () => {
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const next = vi.fn();
    await requireAdmin({ user: { id: 'u1', username: 'u', role: 'ADMIN' } } as never, res as never, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('a request without an identity is refused without querying', async () => {
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const next = vi.fn();
    await requireAdmin({} as never, res as never, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
});

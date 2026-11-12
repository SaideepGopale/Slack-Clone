import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { app } from '../app';

/**
 * P3 (FA-SEC-10, code part): API responses no longer advertise the framework
 * and always carry baseline hardening headers.
 */
describe('baseline security headers (P3)', () => {
  it('are sent on API responses, including errors', async () => {
    for (const res of [await request(app).get('/api/health'), await request(app).get('/api/workspaces')]) {
      expect(res.headers['x-powered-by']).toBeUndefined();
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(res.headers['x-frame-options']).toBe('DENY');
    }
  });
});

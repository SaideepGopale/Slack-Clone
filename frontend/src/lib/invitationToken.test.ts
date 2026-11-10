import { describe, expect, it } from 'vitest';
import { isInvitationToken } from './invitationToken';

/** P1-E — FA-SEC-04: invitation tokens are UUIDs (Invitation.token @default(uuid())). */
describe('isInvitationToken (FA-SEC-04)', () => {
  it('accepts canonical UUIDs (any case)', () => {
    for (const token of ['c7a5b8e2-3f4d-4a1b-9c2d-8e7f6a5b4c3d', 'C7A5B8E2-3F4D-4A1B-9C2D-8E7F6A5B4C3D', '00000000-0000-0000-0000-000000000000']) {
      expect(isInvitationToken(token), token).toBe(true);
    }
  });

  it('rejects everything else', () => {
    const uuid = 'c7a5b8e2-3f4d-4a1b-9c2d-8e7f6a5b4c3d';
    for (const value of [
      undefined,
      null,
      42,
      '',
      '..',
      '../../admin/users/x/ban',
      `${uuid}/../../admin/users/x/ban`,
      `${uuid}?x=1`,
      `${uuid}#x`,
      `${uuid}&email=a`,
      ` ${uuid}`,
      `${uuid}\n`,
      `{${uuid}}`,
      `urn:uuid:${uuid}`,
      uuid.replace(/-/g, ''),
      `${uuid}0`,
      uuid.replace('c', 'g'),
    ]) {
      expect(isInvitationToken(value), JSON.stringify(value)).toBe(false);
    }
  });
});

/**
 * Invitation tokens are UUIDs (backend: Invitation.token @default(uuid())).
 *
 * P1-E (FA-SEC-04): the auth pages read the token from the address bar
 * ("/login?inviteToken=…", "/invite/:token") and used to put it into request
 * paths as-is, so "../../admin/users/<id>/ban" made a signed-in admin's
 * browser send POST /api/admin/users/<id>/ban. Only a canonical UUID may now
 * reach a request or a redirect; anything else is refused before any request.
 */
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isInvitationToken = (value: unknown): value is string =>
  typeof value === 'string' && CANONICAL_UUID.test(value);

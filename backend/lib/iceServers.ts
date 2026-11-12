import { createHmac } from 'crypto';

/**
 * WebRTC ICE server configuration (T.32, audit H4).
 *
 * STUN alone only works when both peers can reach each other directly; behind
 * symmetric NAT or strict firewalls (common on corporate and mobile networks)
 * calls need a TURN relay. Nothing is hard-coded in the browser any more: the
 * backend hands each signed-in caller the configured servers.
 *
 * Environment (all optional):
 *   CALL_STUN_URLS        comma-separated stun: URLs (default: Google's public STUN)
 *   CALL_TURN_URLS        comma-separated turn:/turns: URLs of your relay
 *   CALL_TURN_SECRET      coturn "use-auth-secret" shared secret → short-lived
 *                         per-user credentials (preferred), or
 *   CALL_TURN_USERNAME / CALL_TURN_CREDENTIAL   static credentials
 *   CALL_TURN_TTL_SECONDS lifetime of generated credentials (default 3600)
 *
 * Without CALL_TURN_URLS the response says `relay: false` — calls still work
 * on open networks, and the UI explains a failure honestly instead of
 * pretending to connect.
 */
const DEFAULT_STUN = ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'];

const list = (raw: string | undefined, scheme: RegExp) =>
  (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => scheme.test(s));

export interface IceConfig {
  iceServers: { urls: string[]; username?: string; credential?: string }[];
  relay: boolean;
  ttlSeconds: number;
}

export const iceConfigFor = (userId: string, env: NodeJS.ProcessEnv = process.env, now = Date.now()): IceConfig => {
  const stun = list(env.CALL_STUN_URLS, /^stuns?:/i);
  const turn = list(env.CALL_TURN_URLS, /^turns?:/i);
  const ttlRaw = Number(env.CALL_TURN_TTL_SECONDS);
  const ttlSeconds = Number.isInteger(ttlRaw) && ttlRaw >= 300 && ttlRaw <= 86_400 ? ttlRaw : 3600;

  const iceServers: IceConfig['iceServers'] = [{ urls: stun.length ? stun : DEFAULT_STUN }];
  let relay = false;
  if (turn.length) {
    if (env.CALL_TURN_SECRET) {
      // coturn REST API scheme: username "<expiry>:<user>", credential =
      // base64(HMAC-SHA1(secret, username)). Expires on its own; no state.
      const username = `${Math.floor(now / 1000) + ttlSeconds}:${userId}`;
      const credential = createHmac('sha1', env.CALL_TURN_SECRET).update(username).digest('base64');
      iceServers.push({ urls: turn, username, credential });
      relay = true;
    } else if (env.CALL_TURN_USERNAME && env.CALL_TURN_CREDENTIAL) {
      iceServers.push({ urls: turn, username: env.CALL_TURN_USERNAME, credential: env.CALL_TURN_CREDENTIAL });
      relay = true;
    }
  }
  return { iceServers, relay, ttlSeconds };
};

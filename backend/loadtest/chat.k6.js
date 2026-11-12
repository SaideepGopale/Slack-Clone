/**
 * T.33 — staged chat + tasks load test (k6). See loadtest/README.md.
 *
 * Each virtual user is one signed-in person with the app open:
 *  - one Socket.IO connection (spoken directly: Engine.IO v4 frames over a
 *    WebSocket), kept for the iteration (~60 s), then reconnected;
 *  - sends a chat message every ~20 s (with ack) into one of their channels;
 *  - every ~30 s loads a page of history, the channel list, and the project
 *    board or "my tasks" over HTTP;
 *  - VUs alternate between BASE_URLS (sticky, like a load balancer with
 *    session affinity).
 *
 * Custom metrics: socket_connect_ms, message_ack_ms, message_delivery_ms
 * (sender clock → another member's socket, same machine clock), and counters
 * for socket errors/unexpected closes and failed acks.
 */
import http from 'k6/http';
import { check } from 'k6';
import { SharedArray } from 'k6/data';
import { Counter, Rate, Trend } from 'k6/metrics';
import { setInterval, setTimeout, clearInterval } from 'k6/timers';
import { WebSocket } from 'k6/websockets';

const BASE_URLS = (__ENV.BASE_URLS || 'http://127.0.0.1:4401').split(',');
const SESSIONS = new SharedArray('sessions', () => JSON.parse(open(__ENV.SESSIONS)));
const SEND_EVERY_MS = Number(__ENV.SEND_EVERY_MS || 20_000);
const READ_EVERY_MS = Number(__ENV.READ_EVERY_MS || 30_000);
const SESSION_MS = Number(__ENV.SESSION_MS || 60_000);

const connectMs = new Trend('socket_connect_ms', true);
const ackMs = new Trend('message_ack_ms', true);
const deliveryMs = new Trend('message_delivery_ms', true);
const socketErrors = new Counter('socket_errors');
const unexpectedCloses = new Counter('socket_unexpected_closes');
const ackFailures = new Counter('message_ack_failures');
const messagesSent = new Counter('messages_sent');
const messagesReceived = new Counter('messages_received');
const httpOk = new Rate('http_ok');

const STAGES = __ENV.STAGES
  ? JSON.parse(__ENV.STAGES)
  : [
      { duration: '1m', target: 50 },
      { duration: '1m', target: 100 },
      { duration: '1m', target: 250 },
      { duration: '2m', target: 500 },
      { duration: '3m', target: 500 },
      { duration: '1m', target: 0 },
    ];

export const options = {
  scenarios: { chat: { executor: 'ramping-vus', startVUs: 0, stages: STAGES, gracefulRampDown: '20s', gracefulStop: '30s' } },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<800'],
    message_ack_ms: ['p(95)<500'],
    message_delivery_ms: ['p(95)<1000'],
  },
  summaryTrendStats: ['min', 'med', 'avg', 'p(90)', 'p(95)', 'p(99)', 'max'],
  discardResponseBodies: false,
};

const get = (base, token, path, name) => {
  const res = http.get(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` }, tags: { name } });
  const ok = check(res, { [`${name} 200`]: (r) => r.status === 200 });
  httpOk.add(ok);
  return res;
};

export default function () {
  const me = SESSIONS[(__VU - 1) % SESSIONS.length];
  const base = BASE_URLS[(__VU - 1) % BASE_URLS.length];
  const wsBase = base.replace(/^http/, 'ws');

  // Opening the app: who am I, my channels.
  get(base, me.token, '/api/auth/me', 'auth_me');
  get(base, me.token, `/api/channels?workspaceId=${me.workspaceId}`, 'channels');

  const started = Date.now();
  let ackId = 0;
  const pending = new Map();
  let ready = false;
  let closing = false;
  const ws = new WebSocket(`${wsBase}/socket.io/?EIO=4&transport=websocket`);
  const timers = [];

  const emit = (event, payload, onAck) => {
    if (onAck) {
      const id = ackId++;
      pending.set(id, onAck);
      ws.send(`42${id}${JSON.stringify([event, payload])}`);
    } else {
      ws.send(`42${JSON.stringify([event, payload])}`);
    }
  };

  const sendMessage = () => {
    if (!ready) return;
    const channelId = me.channelIds[Math.floor(Math.random() * me.channelIds.length)];
    const sentAt = Date.now();
    messagesSent.add(1);
    emit('message:send', { channelId, content: `<p>lt|${sentAt}|${__VU}</p>`, clientId: `k6-${__VU}-${sentAt}-${ackId}` }, (res) => {
      ackMs.add(Date.now() - sentAt);
      if (!res || !res.ok) ackFailures.add(1);
    });
  };

  const readPages = () => {
    const channelId = me.channelIds[Math.floor(Math.random() * me.channelIds.length)];
    get(base, me.token, `/api/channels/${channelId}/messages?limit=50`, 'messages_page');
    if (Math.random() < 0.5) get(base, me.token, `/api/projects/${me.projectId}/tasks`, 'task_board');
    else get(base, me.token, `/api/workspaces/${me.workspaceId}/my-tasks?view=assigned`, 'my_tasks');
  };

  ws.onmessage = (e) => {
    const data = typeof e.data === 'string' ? e.data : '';
    if (data === '2') return ws.send('3'); // ping → pong
    if (data[0] === '0') return ws.send(`40${JSON.stringify({ token: me.token })}`); // engine open → namespace connect
    if (data.startsWith('40')) {
      ready = true;
      connectMs.add(Date.now() - started);
      timers.push(setTimeout(sendMessage, Math.random() * SEND_EVERY_MS));
      timers.push(setInterval(sendMessage, SEND_EVERY_MS));
      timers.push(setInterval(readPages, READ_EVERY_MS));
      return;
    }
    if (data.startsWith('44')) {
      socketErrors.add(1);
      return;
    }
    if (data.startsWith('43')) {
      const match = /^43(\d+)(.*)$/.exec(data);
      if (match) {
        const cb = pending.get(Number(match[1]));
        pending.delete(Number(match[1]));
        if (cb) cb(JSON.parse(match[2])[0]);
      }
      return;
    }
    if (data.startsWith('42')) {
      const [event, payload] = JSON.parse(data.slice(2));
      if (event === 'message:received' && payload && typeof payload.content === 'string') {
        const m = /lt\|(\d+)\|(\d+)/.exec(payload.content);
        if (m && Number(m[2]) !== __VU) {
          messagesReceived.add(1);
          deliveryMs.add(Date.now() - Number(m[1]));
        }
      }
    }
  };
  ws.onerror = () => socketErrors.add(1);
  ws.onclose = () => {
    if (!closing) unexpectedCloses.add(1);
    timers.forEach((t) => clearInterval(t));
  };

  setTimeout(() => {
    closing = true;
    timers.forEach((t) => clearInterval(t));
    ws.close();
  }, SESSION_MS);
}

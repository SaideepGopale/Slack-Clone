import axios from 'axios';
import { useEffect, useState } from 'react';
import { io, Socket } from 'socket.io-client';

/**
 * T.32 (audit FE-10): where the real-time server lives. VITE_BACKEND_URL,
 * else the API origin, else — in development only — the local backend. A
 * production build never silently targets localhost; it falls back to its
 * own origin, the same rule the REST client uses.
 */
export const socketServerUrl = (env: { VITE_BACKEND_URL?: string; VITE_API_URL?: string; DEV?: boolean } = import.meta.env) =>
  env.VITE_BACKEND_URL || env.VITE_API_URL || (env.DEV ? 'http://localhost:3000' : typeof window !== 'undefined' ? window.location.origin : '');

// Network-level failures (retry silently) vs. refusals by the server's
// authentication check (the session may be over — ask the API).
const TRANSPORT_ERRORS = /xhr poll error|websocket error|timeout|transport/i;

export const useSocket = (token: string | null) => {
  const [socket, setSocket] = useState<Socket | null>(null);

  useEffect(() => {
    if (!token) return;

    const newSocket = io(socketServerUrl(), {
      auth: { token },
      transports: ['websocket', 'polling'],
      reconnection: true,
      // Previously capped at 5 attempts, after which the app silently stopped
      // receiving messages for good (e.g. across a Render cold start).
      // Retry forever with capped exponential backoff instead.
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10000,
    });

    setSocket(newSocket);

    // T.32 (audit FE-11): when the server refuses the socket's session, check
    // the session over REST — a 401 there signs the user out (AuthContext's
    // interceptor) instead of the socket retrying a dead token forever.
    let lastProbe = 0;
    newSocket.on('connect_error', (err) => {
      console.warn('Socket connection error:', err.message);
      if (TRANSPORT_ERRORS.test(err.message) || Date.now() - lastProbe < 15_000) return;
      lastProbe = Date.now();
      axios.get('/api/auth/me').catch(() => undefined);
    });

    newSocket.on('error', (err) => {
      console.warn('Socket reported an error:', err);
    });

    newSocket.on('disconnect', (reason) => {
      if (reason === 'io server disconnect') {
        // the disconnection was initiated by the server, you need to reconnect manually
        newSocket.connect();
      }
    });

    return () => {
      newSocket.disconnect();
    };
  }, [token]);

  return socket;
};

export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'offline';

/**
 * Live connection state for UI feedback. "offline" means the browser reports
 * no network at all; "reconnecting" means the socket dropped and is retrying.
 */
export const useConnectionStatus = (socket: Socket | null): ConnectionStatus => {
  const [status, setStatus] = useState<ConnectionStatus>(socket?.connected ? 'connected' : 'connecting');

  useEffect(() => {
    if (!socket) return;
    const isOffline = () => typeof navigator !== 'undefined' && navigator.onLine === false;
    let everConnected = socket.connected;
    const refresh = () => {
      if (socket.connected) setStatus('connected');
      else if (isOffline()) setStatus('offline');
      else setStatus(everConnected ? 'reconnecting' : 'connecting');
    };
    const onConnect = () => {
      everConnected = true;
      refresh();
    };

    refresh();
    socket.on('connect', onConnect);
    socket.on('disconnect', refresh);
    socket.io.on('reconnect_attempt', refresh);
    window.addEventListener('online', refresh);
    window.addEventListener('offline', refresh);
    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', refresh);
      socket.io.off('reconnect_attempt', refresh);
      window.removeEventListener('online', refresh);
      window.removeEventListener('offline', refresh);
    };
  }, [socket]);

  return status;
};

import { useEffect, useState } from 'react';
import { io, Socket } from 'socket.io-client';

export const useSocket = (token: string | null) => {
  const [socket, setSocket] = useState<Socket | null>(null);

  useEffect(() => {
    if (!token) return;

    // Local default = the backend dev server (PORT=3000, P0); production sets VITE_BACKEND_URL.
    const backendUrl = import.meta.env.VITE_BACKEND_URL ?? 'http://localhost:3000';
    const newSocket = io(backendUrl, {
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

    newSocket.on('connect_error', (err) => {
      console.warn('Socket connection error:', err.message);
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

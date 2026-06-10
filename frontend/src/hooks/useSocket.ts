import { useState, useEffect } from 'react';
import { io, Socket } from 'socket.io-client';

export const useSocket = (token: string | null) => {
  const [socket, setSocket] = useState<Socket | null>(null);

  useEffect(() => {
    if (!token) return;

    const newSocket = io({
      auth: { token },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000
    });

    setSocket(newSocket);

    newSocket.on('connect_error', (err) => {
      console.warn('Socket connection error (expected in some dev states):', err.message);
    });

    newSocket.on('error', (err) => {
      console.warn('Socket reported an error:', err);
    });

    newSocket.on('disconnect', (reason) => {
      if (reason === 'io server disconnect') {
        // the disconnection was initiated by the server, you need to reconnect manually
        newSocket.connect();
      }
      console.log('Socket disconnected:', reason);
    });

    return () => {
      if (newSocket) {
        newSocket.disconnect();
      }
    };
  }, [token]);

  return socket;
};

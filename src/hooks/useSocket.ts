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
      console.error('Socket connection error:', err.message);
    });

    return () => {
      if (newSocket) {
        newSocket.disconnect();
      }
    };
  }, [token]);

  return socket;
};

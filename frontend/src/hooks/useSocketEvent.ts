import { useEffect, useRef } from 'react';
import type { Socket } from 'socket.io-client';

/**
 * Subscribes to one Socket.IO event for the lifetime of the component. The
 * latest handler is always called, but the listener is registered once per
 * socket/event (no re-subscription on every render) and always removed.
 */
export const useSocketEvent = <T>(socket: Socket | null | undefined, event: string, handler: (payload: T) => void) => {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  useEffect(() => {
    if (!socket) return;
    const listener = (payload: T) => handlerRef.current(payload);
    socket.on(event, listener);
    return () => {
      socket.off(event, listener);
    };
  }, [socket, event]);
};

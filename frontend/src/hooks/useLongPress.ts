import { useCallback, useEffect, useRef } from 'react';
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';

/**
 * T.39 — press-and-hold on touch (pointerType "touch" only; mouse and pen
 * keep their usual hover/right-click behaviour). Moving the finger more than
 * a few pixels (scrolling) cancels it. After it fires, the click that follows
 * the lift and the browser's own context menu are suppressed.
 */
const MOVE_TOLERANCE_PX = 10;

export const useLongPress = <T,>(onLongPress: (item: T) => void, ms = 450) => {
  const callback = useRef(onLongPress);
  callback.current = onLongPress;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);
  const touching = useRef(false);

  const cancel = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    origin.current = null;
  }, []);
  useEffect(() => cancel, [cancel]);

  return useCallback(
    (item: T) => ({
      onPointerDown: (e: ReactPointerEvent) => {
        touching.current = e.pointerType === 'touch';
        if (!touching.current) return;
        fired.current = false;
        origin.current = { x: e.clientX, y: e.clientY };
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => {
          timer.current = null;
          fired.current = true;
          navigator.vibrate?.(8);
          callback.current(item);
        }, ms);
      },
      onPointerMove: (e: ReactPointerEvent) => {
        if (!origin.current) return;
        if (Math.hypot(e.clientX - origin.current.x, e.clientY - origin.current.y) > MOVE_TOLERANCE_PX) cancel();
      },
      onPointerUp: cancel,
      onPointerCancel: cancel,
      onContextMenu: (e: ReactMouseEvent) => {
        if (touching.current) e.preventDefault();
      },
      onClickCapture: (e: ReactMouseEvent) => {
        if (fired.current) {
          e.preventDefault();
          e.stopPropagation();
          fired.current = false;
        }
      },
    }),
    [cancel, ms]
  );
};

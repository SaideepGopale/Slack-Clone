/**
 * Who is typing in the open conversation. Each name expires TYPING_TTL_MS
 * after its last `typing:started`, so an indicator never sticks when the
 * typist closes the tab or drops offline before sending `typing:stop`
 * (senders repeat `typing:start` every 2 s while typing).
 */
export const TYPING_TTL_MS = 6_000;

export const createTypingTracker = (onChange: (names: string[]) => void, ttlMs = TYPING_TTL_MS) => {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const emit = () => onChange([...timers.keys()]);

  const stop = (name: string) => {
    const timer = timers.get(name);
    if (timer === undefined) return;
    clearTimeout(timer);
    timers.delete(name);
    emit();
  };

  const start = (name: string) => {
    const known = timers.has(name);
    clearTimeout(timers.get(name));
    timers.set(name, setTimeout(() => stop(name), ttlMs));
    if (!known) emit();
  };

  const clear = () => {
    if (timers.size === 0) return;
    timers.forEach((timer) => clearTimeout(timer));
    timers.clear();
    emit();
  };

  return { start, stop, clear };
};

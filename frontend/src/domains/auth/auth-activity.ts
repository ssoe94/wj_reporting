export const AUTH_ACTIVITY_INTERVAL_MS = 60_000;
export const AUTH_ACTIVITY_FRESH_MS = 5_000;
const activityEvents = ['pointerdown', 'keydown', 'wheel'] as const;

export type AuthActivityRequest = { signal: AbortSignal; isFresh: () => boolean };
type ActivityEvent = { type: string; isTrusted: boolean; repeat?: boolean };

export function isUserAuthActivity(event: ActivityEvent, visible: boolean, focused: boolean) {
  return event.isTrusted && visible && focused
    && activityEvents.some((name) => name === event.type)
    && !(event.type === 'keydown' && event.repeat);
}

// No timer, event payload, retry queue or background request can create activity.
export function createAuthActivityTracker(options: {
  current: () => boolean;
  foreground: () => boolean;
  send: (request: AuthActivityRequest) => Promise<void>;
  now?: () => number;
}) {
  const now = options.now ?? (() => performance.now());
  let disposed = false;
  let lastAttempt = -Infinity;
  let pending: AbortController | null = null;
  const current = () => !disposed && options.current();
  return {
    handle(event: ActivityEvent) {
      if (!isUserAuthActivity(event, options.foreground(), true) || !current() || pending) return;
      const observedAt = now();
      if (observedAt - lastAttempt < AUTH_ACTIVITY_INTERVAL_MS) return;
      lastAttempt = observedAt;
      const request = new AbortController(); pending = request;
      const isFresh = () => current() && !request.signal.aborted && options.foreground()
        && now() >= observedAt && now() - observedAt <= AUTH_ACTIVITY_FRESH_MS;
      void options.send({ signal: request.signal, isFresh }).catch(() => {
        // Transport or policy failures never queue a deferred activity retry.
      }).finally(() => { if (pending === request) pending = null; });
    },
    dispose() { disposed = true; pending?.abort(); pending = null; },
  };
}

export function observeAuthActivity(options: Parameters<typeof createAuthActivityTracker>[0]) {
  const tracker = createAuthActivityTracker(options);
  const listener = (event: Event) => tracker.handle(event as Event & { repeat?: boolean });
  for (const name of activityEvents) window.addEventListener(name, listener, { capture: true, passive: true });
  return () => {
    for (const name of activityEvents) window.removeEventListener(name, listener, true);
    tracker.dispose();
  };
}

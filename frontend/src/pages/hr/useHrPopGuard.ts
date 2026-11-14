import { useEffect } from 'react';
import { useBlocker } from 'react-router-dom';
import type { Location } from 'react-router-dom';

/** Links and unload have their own guards. The router handles browser Back/Forward. */
export function useHrPopGuard(dirty: boolean, busy: boolean, message: string, ignore?: (next: Location) => boolean) {
  const blocker = useBlocker(({ historyAction, currentLocation, nextLocation }) =>
    historyAction === 'POP' && (dirty || busy) &&
    (currentLocation.pathname !== nextLocation.pathname || currentLocation.search !== nextLocation.search) &&
    !ignore?.(nextLocation));
  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    if (busy || (dirty && !window.confirm(message))) blocker.reset();
    else blocker.proceed();
  }, [blocker, busy, dirty, message]);
}

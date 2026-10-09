import { useCallback, useRef } from 'react';
import type { RefObject } from 'react';
import { useBeforeUnload, useBlocker, useLocation } from 'react-router-dom';
import type { BlockerFunction } from 'react-router-dom';
import { inspectionNavigationGate, inspectionRouteLeaveGate } from './navigation';

/** App Link/navigate/POP protection. Refs are updated before mutations or edits begin. */
export function useInspectionRouteLeaveGuard(dirty: RefObject<boolean>, locked: RefObject<boolean>) {
  const owningPath = useRef(useLocation().pathname);
  const blocker = useBlocker(useCallback<BlockerFunction>(({ currentLocation, nextLocation }) => (
    inspectionRouteLeaveGate(currentLocation, nextLocation, dirty.current, locked.current, owningPath.current) !== 'allow'
  ), [dirty, locked]));

  useBeforeUnload(useCallback((event) => {
    if (inspectionNavigationGate(dirty.current, locked.current) === 'allow') return;
    event.preventDefault();
    event.returnValue = '';
  }, [dirty, locked]));

  const stay = () => { if (blocker.state === 'blocked') blocker.reset(); };
  const leave = () => {
    // A request may have become busy after a dirty-draft confirmation opened.
    if (blocker.state !== 'blocked' || inspectionNavigationGate(dirty.current, locked.current) === 'blocked') return;
    blocker.proceed();
  };

  return {
    blocked: blocker.state === 'blocked',
    canLeave: inspectionNavigationGate(dirty.current, locked.current) !== 'blocked',
    stay,
    leave,
  };
}

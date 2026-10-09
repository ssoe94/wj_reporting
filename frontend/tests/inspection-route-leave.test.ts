import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryRouter } from 'react-router-dom';
import { inspectionNavigationGate, inspectionRouteLeaveGate } from '../src/pages/quality/inspection-requests/navigation.ts';

const inspectionLocation = { pathname: '/quality/inspection-requests', search: '', hash: '' };

test('only a real URL change triggers inspection leave protection', () => {
  assert.equal(inspectionRouteLeaveGate(inspectionLocation, { ...inspectionLocation }, true, true), 'allow');
  for (const next of [{ ...inspectionLocation, pathname: '/analysis' }, { ...inspectionLocation, search: '?view=other' }, { ...inspectionLocation, hash: '#other' }]) {
    assert.equal(inspectionRouteLeaveGate(inspectionLocation, next, true, false), 'confirm');
    assert.equal(inspectionRouteLeaveGate(inspectionLocation, next, false, true), 'blocked');
    assert.equal(inspectionRouteLeaveGate(inspectionLocation, next, false, false), 'allow');
  }
});

test('Data Router menu/navigate transitions remain on the inspection route until explicit dirty confirmation', { timeout: 2000 }, async () => {
  let dirty = true; let locked = false;
  const router = createMemoryRouter([{ path: '*' }], { initialEntries: [inspectionLocation.pathname] });
  try {
    router.getBlocker('inspection-test', ({ currentLocation, nextLocation }) => inspectionRouteLeaveGate(currentLocation, nextLocation, dirty, locked) !== 'allow');
    await router.navigate('/analysis');
    assert.equal(router.state.location.pathname, inspectionLocation.pathname);
    let blocker = router.state.blockers.get('inspection-test');
    assert.equal(blocker?.state, 'blocked');
    if (blocker?.state === 'blocked') blocker.reset();
    assert.equal(router.state.location.pathname, inspectionLocation.pathname);
    await router.navigate('/analysis');
    blocker = router.state.blockers.get('inspection-test');
    assert.equal(blocker?.state, 'blocked');
    // A mutation that starts after the dialog opened must prevent its continue action.
    locked = true;
    assert.equal(inspectionNavigationGate(dirty, locked), 'blocked');
    assert.equal(router.state.location.pathname, inspectionLocation.pathname);
    locked = false; dirty = false;
    const didNavigate = new Promise<void>((resolve) => {
      const unsubscribe = router.subscribe((state) => {
        if (state.location.pathname === '/analysis') { unsubscribe(); resolve(); }
      });
    });
    if (blocker?.state === 'blocked') blocker.proceed();
    await didNavigate;
    assert.equal(router.state.location.pathname, '/analysis');
  } finally { router.dispose(); }
});

test('Data Router POP/back and replace are blocked while pending and work normally when clean', { timeout: 2000 }, async () => {
  let locked = true;
  const router = createMemoryRouter([{ path: '*' }], { initialEntries: ['/analysis', inspectionLocation.pathname], initialIndex: 1 });
  try {
    router.getBlocker('inspection-test', ({ currentLocation, nextLocation }) => inspectionRouteLeaveGate(currentLocation, nextLocation, false, locked) !== 'allow');
    await router.navigate(-1);
    assert.equal(router.state.location.pathname, inspectionLocation.pathname);
    let blocker = router.state.blockers.get('inspection-test');
    assert.equal(blocker?.state, 'blocked');
    if (blocker?.state === 'blocked') blocker.reset();
    await router.navigate('/analysis', { replace: true });
    assert.equal(router.state.location.pathname, inspectionLocation.pathname);
    blocker = router.state.blockers.get('inspection-test');
    assert.equal(blocker?.state, 'blocked');
    if (blocker?.state === 'blocked') blocker.reset();
    locked = false;
    await router.navigate('/analysis');
    assert.equal(router.state.location.pathname, '/analysis');
  } finally { router.dispose(); }
});

test('an outgoing inspection blocker cannot prevent returning from the page deliberately opened', { timeout: 2000 }, async () => {
  const router = createMemoryRouter([{ path: '*' }], { initialEntries: [inspectionLocation.pathname] });
  try {
    // Keep the original dirty state and blocker registered to model an exit animation.
    router.getBlocker('inspection-exit', ({ currentLocation, nextLocation }) => inspectionRouteLeaveGate(currentLocation, nextLocation, true, false, inspectionLocation.pathname) !== 'allow');
    await router.navigate('/analysis');
    const blocker = router.state.blockers.get('inspection-exit');
    assert.equal(blocker?.state, 'blocked');
    const didLeave = new Promise<void>((resolve) => {
      const unsubscribe = router.subscribe((state) => {
        if (state.location.pathname === '/analysis') { unsubscribe(); resolve(); }
      });
    });
    if (blocker?.state === 'blocked') blocker.proceed();
    await didLeave;
    await router.navigate(inspectionLocation.pathname);
    assert.equal(router.state.location.pathname, inspectionLocation.pathname);
    await router.navigate('/analysis');
    assert.equal(router.state.location.pathname, inspectionLocation.pathname, 'when inspection owns the current route again, dirty protection still applies');
    assert.equal(router.state.blockers.get('inspection-exit')?.state, 'blocked');
  } finally { router.dispose(); }
});

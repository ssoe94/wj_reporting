import assert from 'node:assert/strict';
import test from 'node:test';
import { HR_PAGES, hrFlowHref, hrPageForPath, legacyHrHref, personnelStep, workStep } from '../src/domains/hr/flow.ts';

test('old HR bookmarks resolve to the correct step and keep their other parameters and fragment', () => {
  const routes = [
    ['roster', '/hr/personnel', 'roster'], ['labor-cost', '/hr/personnel', 'cost'],
    ['daily-work', '/hr/work', 'daily'], ['labor-forecast', '/hr/work', 'forecast'],
    ['labor-standards', '/hr/work', 'standards'],
  ];
  for (const [old, path, step] of routes) {
    const next = legacyHrHref(`/hr/${old}/`, '?month=2026-10&date=2026-10-19&step=old&tag=a&tag=b', '#proof');
    assert.ok(next);
    const url = new URL(next, 'https://example.invalid');
    assert.equal(url.pathname, path);
    assert.equal(url.searchParams.get('step'), step);
    assert.equal(url.searchParams.get('month'), '2026-10');
    assert.equal(url.searchParams.get('date'), '2026-10-19');
    assert.deepEqual(url.searchParams.getAll('tag'), ['a', 'b']);
    assert.equal(url.hash, '#proof');
  }
  assert.equal(legacyHrHref('/hr/dashboard', '?month=2026-10'), null);
});

test('monthly close defaults to uploading without payroll and to assignment with payroll', () => {
  assert.equal(personnelStep('?month=2026-11', false), 'upload');
  assert.equal(personnelStep('?month=2026-11', true), 'assign');
  assert.equal(personnelStep('?step=roster', false), 'roster');
  assert.equal(personnelStep('?step=cost', true), 'cost');
  assert.equal(personnelStep('?step=forecast', true), 'assign');
  assert.equal(workStep(''), 'daily');
  assert.equal(workStep('?step=standards'), 'standards');
  assert.equal(workStep('?step=assign'), 'daily');
});

test('three menu and tab destinations stay selected for canonical and legacy routes', () => {
  assert.deepEqual(HR_PAGES.map(({ path }) => path), ['/hr/dashboard', '/hr/personnel', '/hr/work']);
  for (const item of HR_PAGES) assert.equal(hrPageForPath(item.path), item.page);
  for (const alias of ['roster', 'labor-cost']) assert.equal(hrPageForPath(`/hr/${alias}`), 'personnel');
  for (const alias of ['daily-work', 'labor-forecast', 'labor-standards']) assert.equal(hrPageForPath(`/hr/${alias}`), 'work');
  assert.equal(hrPageForPath('/hr/dashboard-extra'), undefined);
  assert.equal(hrFlowHref('work', 'forecast', '2026-10', '?date=2026-10-19&step=daily', '#proof'),
    '/hr/work?date=2026-10-19&step=forecast&month=2026-10#proof');
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { canAccessHr, isHrRoute } from '../src/domains/auth/hr-access.ts';

test('HR requires explicit server authorization or superuser, never staff/admin/group/name', () => {
  for (const user of [null, undefined, {}, { is_staff: true }, { permissions: { is_admin: true } }, { groups: ['HR'] }, { department: '인사' }, { can_access_hr: 'true' }]) {
    assert.equal(canAccessHr(user as Parameters<typeof canAccessHr>[0]), false);
  }
  assert.equal(canAccessHr({ is_superuser: true }), true);
  assert.equal(canAccessHr({ can_access_hr: true }), true);
  assert.equal(canAccessHr({ is_superuser: true, is_active: false }), false);
});

test('all HR routes are guarded before broad staff/admin route grants', () => {
  for (const path of ['/hr', '/hr/personnel', '/HR/LABOR-COST/', '/%68r/personnel?month=2026-10', '/hr/new#section']) assert.equal(isHrRoute(path), true);
  for (const path of ['/hr-other', '/development/field-materials', '/%invalid']) assert.equal(isHrRoute(path), false);
});

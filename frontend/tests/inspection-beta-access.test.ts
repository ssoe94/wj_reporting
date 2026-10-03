import assert from 'node:assert/strict';
import test from 'node:test';
import { canUseInspectionBeta, isInspectionBetaRoute } from '../src/domains/auth/inspection-beta-access.ts';

test('inspection beta requires explicit active superuser authority before broad staff/admin/quality grants', () => {
  for (const user of [null, undefined, {}, { is_superuser: false }, { is_superuser: true, is_active: false }, { is_staff: true }, { permissions: { is_admin: true, can_view_quality: true } }, { is_superuser: 'true' }]) {
    assert.equal(canUseInspectionBeta(user as Parameters<typeof canUseInspectionBeta>[0]), false);
  }
  assert.equal(canUseInspectionBeta({ is_superuser: true }), true);
  assert.equal(canUseInspectionBeta({ is_superuser: true, is_active: true }), true);
});

test('inspection route matching covers router decoding, case and nested paths while preserving neighboring quality routes', () => {
  for (const route of ['/quality/inspection-requests', '/quality/inspection-requests/', '/quality/inspection-requests/1', '/quality/inspection-requests?date=2026-09-30', '/quality/inspection-requests#detail', '/QUALITY/INSPECTION-REQUESTS', '/quality/%69nspection-requests']) {
    assert.equal(isInspectionBetaRoute(route), true);
  }
  for (const route of ['/quality', '/quality/analysis', '/quality/inspection-requests-other', '/quality/%invalid']) {
    assert.equal(isInspectionBetaRoute(route), false);
  }
});

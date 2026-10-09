import assert from 'node:assert/strict';
import test from 'node:test';
import { canUseInspectionBeta, isInspectionBetaRoute, parseInspectionAccess } from '../src/domains/auth/inspection-beta-access.ts';

const all = { can_view: true, can_manage: true, can_submit: true, can_review: true, access_scope: 'all', can_view_kanban: true } as const;
const assigned = { can_view: true, can_manage: false, can_submit: true, can_review: false, access_scope: 'assigned_only', can_view_kanban: false } as const;

test('staff/admin/quality/superuser flags alone cannot bypass pending or denied server capabilities', () => {
  for (const user of [null, undefined, {}, { id: 1, is_superuser: false }, { id: 1, is_superuser: true }, { id: 1, is_staff: true }, { id: 1, permissions: { is_admin: true, can_view_quality: true } }]) {
    assert.equal(canUseInspectionBeta(user as Parameters<typeof canUseInspectionBeta>[0]), false);
    assert.equal(canUseInspectionBeta(user as Parameters<typeof canUseInspectionBeta>[0], { ...all, can_view: false }), false);
  }
});

test('explicit server capabilities allow full and assigned-only active users without a name or staff gate', () => {
  assert.equal(canUseInspectionBeta({ id: 1 }, all), true);
  assert.equal(canUseInspectionBeta({ id: 2, is_active: true }, assigned), true);
  assert.equal(canUseInspectionBeta({ id: 2, is_active: false }, assigned), false);
  assert.equal(canUseInspectionBeta(null, assigned), false);
});

test('malformed or contradictory capability responses fail closed', () => {
  for (const value of [null, {}, { ...all, can_view: 'true' }, { ...all, can_manage: null }, { ...all, access_scope: 'unknown' }, { ...assigned, can_view_kanban: true }, { ...assigned, can_review: true }]) {
    assert.equal(parseInspectionAccess(value), null);
    assert.equal(canUseInspectionBeta({ id: 1 }, value as Parameters<typeof canUseInspectionBeta>[1]), false);
  }
});

test('inspection route matching covers router decoding, case and nested paths while preserving neighboring quality routes', () => {
  for (const route of ['/quality/inspection-requests', '/quality/inspection-requests/', '/quality/inspection-requests/1', '/quality/inspection-requests?date=2026-09-30', '/quality/inspection-requests#detail', '/QUALITY/INSPECTION-REQUESTS', '/quality/%69nspection-requests']) {
    assert.equal(isInspectionBetaRoute(route), true);
  }
  for (const route of ['/quality', '/quality/analysis', '/quality/inspection-requests-other', '/quality/%invalid']) {
    assert.equal(isInspectionBetaRoute(route), false);
  }
});

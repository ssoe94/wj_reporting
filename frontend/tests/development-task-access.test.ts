import assert from 'node:assert/strict';
import test from 'node:test';
import { canManageDevelopmentTasks, isDevelopmentTaskRoute } from '../src/domains/auth/development-task-access.ts';

test('development tasks require an explicit superuser flag; staff and admin grants do not substitute', () => {
  for (const user of [null, undefined, {}, { is_superuser: false }, { is_staff: true }, { permissions: { is_admin: true } }]) {
    assert.equal(canManageDevelopmentTasks(user as { is_superuser?: boolean } | null | undefined), false);
  }
  assert.equal(canManageDevelopmentTasks({ is_superuser: true }), true);
  assert.equal(canManageDevelopmentTasks({ is_superuser: 'true' } as unknown as { is_superuser: boolean }), false);
});

test('route guard covers trailing paths, search and fragments without changing neighboring routes', () => {
  for (const route of ['/admin/development-tasks', '/admin/development-tasks/', '/admin/development-tasks/one', '/admin/development-tasks?status=done', '/admin/development-tasks#requirements', '/ADMIN/DEVELOPMENT-TASKS', '/Admin/Development-Tasks/', '/admin/%64evelopment-tasks']) {
    assert.equal(isDevelopmentTaskRoute(route), true);
  }
  for (const route of ['/development/field-materials', '/admin/user-management', '/admin/development-tasks-other', '/admin/%invalid']) {
    assert.equal(isDevelopmentTaskRoute(route), false);
  }
});

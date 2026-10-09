import assert from 'node:assert/strict';
import test from 'node:test';
import { canSetHrPermission, hrPermissionPayload } from '../src/domains/auth/hr-grant.ts';

const permissions = { is_admin: false, can_edit_quality: true, can_manage_hr: true };
const root = { is_superuser: true };

test('only active superusers can send an explicit HR permission on creation', () => {
  for (const actor of [null, {}, { is_superuser: false }, { is_superuser: true, is_active: false }]) {
    assert.equal(canSetHrPermission(actor), false);
    assert.deepEqual(hrPermissionPayload(permissions, actor), { is_admin: false, can_edit_quality: true });
  }
  assert.deepEqual(hrPermissionPayload(permissions, root), permissions);
});

test('account edits omit unchanged HR state so unrelated edits cannot overwrite a newer grant', () => {
  assert.equal('can_manage_hr' in hrPermissionPayload(permissions, root, { can_manage_hr: true }), false);
  assert.equal(hrPermissionPayload(permissions, root, { can_manage_hr: false }).can_manage_hr, true);
  assert.equal(hrPermissionPayload({ ...permissions, can_manage_hr: false }, root, { can_manage_hr: true }).can_manage_hr, false);
  assert.equal(permissions.can_manage_hr, true);
});

test('superuser automatic access is never submitted as an editable grant', () => {
  assert.equal('can_manage_hr' in hrPermissionPayload(permissions, root, { is_superuser: true }), false);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { planBomErrorMessage } from '../src/domains/production/plan-bom-errors.ts';

test('BOM validation arrays and transport detail objects retain distinct reasons', () => {
  assert.match(planBomErrorMessage({ response: { status: 400, data: ['mes_bom_complex_control'] } }, false), /투입 관리/);
  assert.match(planBomErrorMessage({ response: { status: 502, data: { detail: 'permission_required' } } }, false), /권한/);
  assert.match(planBomErrorMessage({ response: { status: 400, data: ['mes_bom_not_found'] } }, true), /没有MES BOM/);
});

test('untrusted provider text is never displayed, even for unexpected shapes', () => {
  for (const data of [['access_token=SECRET'], { detail: 'SECRET' }, { detail: ['SECRET'] }, 'SECRET', null, ['mes_bom_not_found', 'SECRET'], { detail: '__proto__' }]) {
    assert.doesNotMatch(planBomErrorMessage({ response: { status: 400, data } }, false), /SECRET|access_token|__proto__/);
  }
});

test('login, denied access and temporary failures give actionable fallback text', () => {
  assert.match(planBomErrorMessage({ response: { status: 401 } }, false), /로그인/);
  assert.match(planBomErrorMessage({ response: { status: 403 } }, true), /权限/);
  for (const error of [null, undefined, new Error('SECRET'), { response: { status: 503 } }]) {
    assert.match(planBomErrorMessage(error, false), /초안.*보존/);
  }
});

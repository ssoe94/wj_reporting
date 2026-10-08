import assert from 'node:assert/strict';
import test from 'node:test';
import { loginReturnPath } from '../src/domains/auth/login-return.ts';

test('confirmed inspector switch returns through existing PrivateRoute state to inspection', () => {
  assert.equal(loginReturnPath(null, { from: { pathname: '/quality/inspection-requests', search: '?page=2' } }), '/quality/inspection-requests?page=2');
  assert.equal(loginReturnPath('/analysis', { from: { pathname: '/quality/inspection-requests' } }), '/analysis');
});

test('external, backslash and control-character return paths cannot escape the app', () => {
  for (const value of ['https://synthetic.invalid', '//synthetic.invalid', '/\\synthetic.invalid', '/\n/synthetic.invalid', '/\tpath', 123, {}]) {
    assert.equal(loginReturnPath(value, { from: { pathname: value } }), '/');
  }
  assert.equal(loginReturnPath(null, { from: { pathname: '/inspection', search: '?x=\r' } }), '/');
});

test('malformed or login-loop route state falls back to the existing landing route', () => {
  for (const value of [null, false, 'inspection', {}, { from: '/inspection' }, { from: { pathname: '/login' } }]) {
    assert.equal(loginReturnPath(null, value), '/');
  }
});

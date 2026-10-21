import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const script = html.match(/<script>\s*([\s\S]*?)<\/script>/)?.[1];
assert.ok(script);

function boot(values: Record<string, string>, denied = false, pathname = '/login') {
  const attributes: Record<string, string> = { 'data-app-theme': 'light' };
  const classes = new Set();
  let meta = '#F3F5F7';
  const element = { style: { colorScheme: '' }, classList: { add: (name: string) => classes.add(name) }, setAttribute: (name: string, value: string) => { attributes[name] = value; } };
  vm.runInNewContext(script!, {
    location: { pathname },
    localStorage: { getItem: (key: string) => { if (denied) throw new Error('restricted storage'); return values[key] ?? null; } },
    document: { documentElement: element, querySelector: () => ({ setAttribute: (_key: string, value: string) => { meta = value; } }) },
  });
  return { attributes, classes, scheme: element.style.colorScheme, meta };
}

test('the first paint applies the stored dark choice before React loads', () => {
  const result = boot({ 'wj:appearance:v1': 'dark' });
  assert.equal(result.attributes['data-app-theme'], 'dark');
  assert.equal(result.scheme, 'dark');
  assert.equal(result.meta, '#101619');
});

test('lightweight mode remains light without replacing the preferred dark choice', () => {
  const values = { 'wj:appearance:v1': 'dark', lite: '1' };
  const result = boot(values);
  assert.ok(result.classes.has('lite-mode'));
  assert.equal(result.attributes['data-app-theme'], 'light');
  assert.equal(result.meta, '#F3F5F7');
  assert.equal(values['wj:appearance:v1'], 'dark');
});

test('invalid or denied storage leaves a readable light first paint', () => {
  assert.equal(boot({ 'wj:appearance:v1': 'corrupt' }).attributes['data-app-theme'], 'light');
  assert.equal(boot({}, true).attributes['data-app-theme'], 'light');
});


test('field first paint forces legacy light even when dark is stored or storage is denied', () => {
  for (const path of ['/field', '/field/imm01', '/field/assy04']) {
    for (const denied of [false, true]) {
      const result = boot({ 'wj:appearance:v1': 'dark' }, denied, path);
      assert.equal(result.attributes['data-app-theme'], 'light');
      assert.equal(result.attributes['data-field-appearance'], 'legacy');
      assert.equal(result.scheme, 'light');
    }
  }
  assert.equal(boot({ 'wj:appearance:v1': 'dark' }, false, '/development/field-materials').scheme, 'dark');
});

test('a recognized field-account hint applies only to its own current auth generation', () => {
  const values = {
    'wj:appearance:v1': 'dark',
    'wj:appearance:field-session:v1': 'field-session',
    'wj-auth-session-control-v2': JSON.stringify({ id: 'field-session' }),
  };
  assert.equal(boot(values).scheme, 'light');
  assert.equal(boot(values).attributes['data-field-appearance'], 'legacy');
  assert.equal(values['wj:appearance:v1'], 'dark');
  assert.equal(boot({ ...values, 'wj-auth-session-control-v2': JSON.stringify({ id: 'other-session' }) }).scheme, 'dark');
  assert.equal(boot({ ...values, 'wj-auth-session-control-v2': JSON.stringify({ id: null }) }).scheme, 'dark');
});


test('injection board first paint is legacy light with dark stored, broken auth storage or denied storage', () => {
  const values = { 'wj:appearance:v1': 'dark', 'wj-auth-session-control-v2': '{broken' };
  for (const path of ['/boards/injection', '/boards/injection/', '/production/injection-board', '/production/injection-board/index.html', '/next/production/injection-board/index.html']) {
    for (const denied of [false, true]) {
      const result = boot(values, denied, path);
      assert.equal(result.attributes['data-app-theme'], 'light');
      assert.equal(result.attributes['data-injection-board-appearance'], 'legacy');
      assert.equal(result.attributes['data-field-appearance'], undefined);
      assert.equal(result.scheme, 'light');
    }
  }
  assert.equal(values['wj:appearance:v1'], 'dark');
  for (const path of ['/boards/injection-history', '/boards/overview', '/boards/inspection', '/production/plan']) {
    const result = boot(values, false, path);
    assert.equal(result.scheme, 'dark');
    assert.equal(result.attributes['data-injection-board-appearance'], undefined);
  }
});

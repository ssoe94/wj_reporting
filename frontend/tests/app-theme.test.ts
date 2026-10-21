import assert from 'node:assert/strict';
import { test } from 'node:test';
import { APP_THEME_STORAGE_KEY, isFieldAppearance, isInjectionBoardAppearance, resolveAppTheme, parseAppTheme, readAppTheme, rememberAppTheme } from '../src/domains/appearance/theme.ts';

test('only a valid dark preference enables dark; unset, corrupt and old lite values use light', () => {
  for (const value of [null, undefined, 'light', '1', 'night', '{}']) assert.equal(parseAppTheme(value), 'light');
  assert.equal(parseAppTheme('dark'), 'dark');
});

test('mode storage is namespaced and can round-trip independently of lite mode', () => {
  const values = new Map([['lite', '1']]);
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  assert.equal(rememberAppTheme('dark', storage), true);
  assert.equal(values.get(APP_THEME_STORAGE_KEY), 'dark');
  assert.equal(values.get('lite'), '1');
  assert.equal(readAppTheme(storage), 'dark');
  rememberAppTheme('light', storage);
  assert.equal(readAppTheme(storage), 'light');
});

test('restricted storage does not prevent rendering or changing the current tab mode', () => {
  const blocked = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
  assert.equal(readAppTheme(blocked), 'light');
  assert.equal(rememberAppTheme('dark', blocked), false);
  assert.equal(readAppTheme(), 'light');
  assert.equal(rememberAppTheme('dark'), false);
});


test('field routes and recognized terminal accounts always use light without changing the preference', () => {
  for (const path of ['/field', '/field/', '/field/imm01', '/field/assy04']) {
    assert.equal(isFieldAppearance(path), true, path);
    assert.equal(resolveAppTheme('dark', false, isFieldAppearance(path)), 'light');
  }
  for (const path of ['/fieldwork', '/development/field-materials', '/production/plan', '/login']) {
    assert.equal(isFieldAppearance(path), false, path);
    assert.equal(resolveAppTheme('dark', false, isFieldAppearance(path)), 'dark');
    assert.equal(resolveAppTheme('dark', false, isFieldAppearance(path, true)), 'light');
  }
  assert.equal(resolveAppTheme('dark', true, false), 'light');
  assert.equal(resolveAppTheme('dark', false, false), 'dark');
});


test('injection board routes use legacy light while other boards keep the saved preference', () => {
  for (const path of ['/boards/injection', '/boards/injection/', '/production/injection-board', '/production/injection-board/index.html', '/next/production/injection-board']) {
    assert.equal(isInjectionBoardAppearance(path), true, path);
    assert.equal(resolveAppTheme('dark', false, isInjectionBoardAppearance(path)), 'light');
  }
  for (const path of ['/boards/injection-history', '/production/injection-board-settings', '/boards/inspection', '/boards/overview', '/production/plan']) {
    assert.equal(isInjectionBoardAppearance(path), false, path);
    assert.equal(resolveAppTheme('dark', false, isInjectionBoardAppearance(path)), 'dark');
  }
});

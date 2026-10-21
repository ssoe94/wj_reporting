import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chartLabelColor } from '../src/domains/appearance/contrast.ts';

test('chart labels stay readable on the unchanged plan/category colors', () => {
  const colors = ['#008ec3', '#00a65a', '#55b8dd', '#f7b924', '#4d8fb5', '#67c587', '#0f9f7a', '#56b991', '#81c9b0', '#93b7c9', '#7c3aed', '#f97316', '#0f766e', '#db2777'];
  const luminance = (hex: string) => [0, 2, 4].map(i => parseInt(hex.replace('#', '').slice(i, i + 2), 16) / 255)
    .map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
    .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
  for (const color of colors) {
    const a = luminance(color), b = luminance(chartLabelColor(color));
    assert.ok((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) >= 4.5, color);
  }
  assert.equal(chartLabelColor('#f7b924'), '#000000');
  assert.equal(chartLabelColor('#7c3aed'), '#ffffff');
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const css = readFileSync(new URL('../src/styles/design-tokens.css', import.meta.url), 'utf8');
const roles = (block: string) => Object.fromEntries([...block.matchAll(/(--wj-[\w-]+):\s*(#[\da-f]+)/gi)].map((m) => [m[1], m[2]]));
const light = roles(css.match(/:root\s*\{([^}]+)/)![1]);
const dark = { ...light, ...roles(css.match(/:root\[data-app-theme="dark"\]\s*\{([^}]+)/)![1]) };
function luminance(hex: string) {
  let value = hex.slice(1);
  if (value.length === 3) value = [...value].map(c => c + c).join('');
  return [0, 2, 4].map(i => parseInt(value.slice(i, i + 2), 16) / 255)
    .map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4)
    .reduce((sum, c, i) => sum + c * [.2126, .7152, .0722][i], 0);
}

test('light and dark text, status fills, image-viewer labels and field boundaries have usable contrast', () => {
  for (const [mode, palette] of Object.entries({ light, dark })) {
    const check = (fg: string, bg: string, minimum = 4.5) => {
      const a = luminance(palette[fg]), b = luminance(palette[bg]);
      const ratio = (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
      assert.ok(ratio >= minimum, `${mode}: ${fg} on ${bg}: ${ratio.toFixed(2)}`);
    };
    for (const surface of ['--wj-bg', '--wj-bg-strong', '--wj-surface-solid']) {
      check('--wj-text', surface);
      check('--wj-muted', surface);
      check('--wj-control-border', surface, 3);
    }
    check('--wj-on-accent', '--wj-accent-strong');
    for (const status of ['success', 'warning', 'danger']) {
      check(`--wj-${status}`, `--wj-${status}-bg`);
      check('--wj-on-accent', `--wj-${status}`);
    }
    check('--wj-info', '--wj-info-bg');
    check('--wj-on-contrast', '--wj-contrast-surface');
    check('--wj-on-contrast-muted', '--wj-contrast-surface');
  }
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function readCssBundle() {
  const stylesDir = resolve(__dirname, '../src/styles');
  const globalCss = readFileSync(resolve(stylesDir, 'global.css'), 'utf8');
  return globalCss.replace(/@import '\.\/(.+?)';/g, (_, file) => readFileSync(resolve(stylesDir, file), 'utf8'));
}

test('search modal exposes date, source, and content type filters', () => {
  const source = readFileSync(resolve(__dirname, '../src/components/SearchModal.tsx'), 'utf8');
  const css = readCssBundle();

  assert.match(source, /Ngày/);
  assert.match(source, /Nguồn/);
  assert.match(source, /Loại tin/);
  assert.match(source, /News/);
  assert.match(source, /Tech/);
  assert.match(source, /VOZ/);
  assert.match(source, /Reddit/);
  assert.match(source, /Bản tin/);
  assert.match(source, /api\.getPublicSources\(\)/);
  assert.match(css, /\.search-filters\s*\{/);
  assert.match(css, /@media \(max-width:\s*640px\)[\s\S]*\.search-filters/);
});

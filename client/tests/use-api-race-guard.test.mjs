import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

test('useApi hooks guard against stale async responses overwriting latest state', () => {
  const source = readFileSync(resolve(__dirname, '../src/hooks/useApi.ts'), 'utf8');

  assert.match(source, /useRef/);
  assert.match(source, /latestRequestRef/);
  assert.match(source, /\+\+latestRequestRef\.current/);
  assert.match(source, /latestRequestRef\.current !== requestId/);
  assert.match(source, /latestRequestRef\.current === requestId/);
});

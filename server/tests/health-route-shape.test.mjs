import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

test('admin health response includes deploy, runtime, and public check groups', () => {
  const source = readFileSync(resolve(__dirname, '../src/routes/health.ts'), 'utf8');

  assert.match(source, /getDeployInfo/);
  assert.match(source, /getRuntimeInfo/);
  assert.match(source, /getPublicChecks/);
  assert.match(source, /deploy,/);
  assert.match(source, /runtime,/);
  assert.match(source, /publicChecks,/);
});

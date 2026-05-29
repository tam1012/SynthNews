import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

test('article routes expose bounded batch actions for admin queues', () => {
  const source = readFileSync(resolve(__dirname, '../src/routes/articles.ts'), 'utf8');

  assert.match(source, /parseBatchIds/);
  assert.match(source, /articles\.post\('\/batch\/reset-summary'/);
  assert.match(source, /articles\.post\('\/batch\/delete'/);
  assert.match(source, /articles\.post\('\/fetch-jobs\/batch\/retry'/);
  assert.match(source, /articles\.post\('\/fetch-jobs\/batch\/delete'/);
  assert.match(source, /ids\.length > 100/);
  assert.match(source, /summary_status = 'pending'/);
  assert.match(source, /runSummarizeJob/);
  assert.match(source, /runArticleFetchJob/);
});

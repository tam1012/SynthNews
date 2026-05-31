import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

test('admin queue tabs use explicit article and fetch-job types instead of local any lists', () => {
  const summarySource = readFileSync(resolve(__dirname, '../src/pages/admin/SummaryQueueTab.tsx'), 'utf8');
  const fetchSource = readFileSync(resolve(__dirname, '../src/pages/admin/FetchJobsTab.tsx'), 'utf8');
  const qualitySource = readFileSync(resolve(__dirname, '../src/pages/admin/QualityControlTab.tsx'), 'utf8');
  const helpersSource = readFileSync(resolve(__dirname, '../src/pages/admin/adminHelpers.ts'), 'utf8');

  assert.match(helpersSource, /export type AdminArticle =/);
  assert.match(helpersSource, /export type AdminArticleFetchJob =/);
  assert.match(summarySource, /AdminArticle/);
  assert.match(fetchSource, /AdminArticleFetchJob/);
  assert.match(qualitySource, /AdminArticle/);

  for (const source of [summarySource, fetchSource, qualitySource]) {
    assert.doesNotMatch(source, /:\s*any\[\]/);
    assert.doesNotMatch(source, /\(\w+:\s*any\)/);
    assert.doesNotMatch(source, /Promise<any>/);
    assert.doesNotMatch(source, /catch \(err: any\)/);
  }
});

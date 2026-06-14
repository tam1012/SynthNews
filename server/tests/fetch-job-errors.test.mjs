import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadClassifier() {
  const source = readFileSync(resolve(__dirname, '../src/services/fetchers/fetch-job-errors.ts'), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const moduleContext = { exports: {} };
  vm.runInNewContext(outputText, { exports: moduleContext.exports, module: moduleContext });
  return moduleContext.exports;
}

test('fetch job error classifier separates retryable and permanent failures', () => {
  const { classifyFetchJobError } = loadClassifier();

  assert.equal(classifyFetchJobError(new Error('HTTP 503 service unavailable')).retryable, true);
  assert.equal(classifyFetchJobError(new Error('request timed out')).retryable, true);
  assert.equal(classifyFetchJobError(new Error('ECONNRESET')).retryable, true);
  assert.equal(classifyFetchJobError(new Error('HTTP 404 not found')).retryable, false);
  assert.equal(classifyFetchJobError(new Error('Article fetch job URL must be a public http(s) URL')).type, 'invalid_url');
});

test('fetch job skipped reason is stable for null article result', () => {
  const { buildNullArticleSkipReason } = loadClassifier();

  assert.equal(buildNullArticleSkipReason('rss'), 'fetcher returned no article for rss source');
});

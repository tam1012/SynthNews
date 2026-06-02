import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadTsModule(relativePath) {
  const source = readFileSync(resolve(__dirname, relativePath), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const moduleContext = { exports: {} };
  vm.runInNewContext(outputText, {
    exports: moduleContext.exports,
    module: moduleContext,
  });
  return moduleContext.exports;
}

test('public GET endpoints are cacheable for short in-app reuse', () => {
  const { getCachePolicy } = loadTsModule('../src/services/apiCache.ts');

  assert.equal(getCachePolicy('/articles?limit=100').cacheable, true);
  assert.equal(getCachePolicy('/articles?limit=100').ttlMs, 60000);
  assert.equal(getCachePolicy('/articles/dates?sourceId=src_1').cacheable, true);
  assert.equal(getCachePolicy('/sources/public').cacheable, true);
  assert.equal(getCachePolicy('/sources/public').ttlMs, 300000);
  assert.equal(getCachePolicy('/digests/latest?lang=vi').cacheable, true);
  assert.equal(getCachePolicy('/digests/latest?lang=vi').ttlMs, 60000);
});

test('mutating and admin endpoints bypass the client cache', () => {
  const { getCachePolicy } = loadTsModule('../src/services/apiCache.ts');

  assert.equal(getCachePolicy('/articles/abc/reset-summary', { method: 'POST' }).cacheable, false);
  assert.equal(getCachePolicy('/ai-providers').cacheable, false);
  assert.equal(getCachePolicy('/sources').cacheable, false);
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadUsage(db) {
  const source = readFileSync(resolve(__dirname, '../src/services/fetchers/hosted-fetch-usage.ts'), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const moduleContext = { exports: {} };
  vm.runInNewContext(outputText, {
    exports: moduleContext.exports,
    module: moduleContext,
    require: (name) => {
      if (name === '../../db/index.js') return db;
      throw new Error(`Unexpected require ${name}`);
    },
  });
  return moduleContext.exports;
}

test('hosted fetch usage allows attempts below cap', async () => {
  const calls = [];
  const { reserveHostedFetchAttempt } = loadUsage({
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [{ used_count: 2, allowed: true }] };
    },
  });

  const result = await reserveHostedFetchAttempt('geekflare', 100);

  assert.equal(result.allowed, true);
  assert.equal(result.usedCount, 2);
  assert.equal(calls[0].params[0], 'geekflare');
});

test('hosted fetch usage denies attempts at cap', async () => {
  const { reserveHostedFetchAttempt } = loadUsage({
    query: async () => ({ rows: [{ used_count: 100, allowed: false }] }),
  });

  const result = await reserveHostedFetchAttempt('geekflare', 100);

  assert.equal(result.allowed, false);
  assert.equal(result.usedCount, 100);
});

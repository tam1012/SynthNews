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
    require: (name) => {
      if (name === './aiRetryPolicy.js') {
        return loadTsModule('../src/lib/aiRetryPolicy.ts');
      }
      throw new Error(`Unexpected require ${name}`);
    },
  });
  return moduleContext.exports;
}

test('retry policy resets failed summaries below retry limit and timeout failures', () => {
  const { buildResetRetryableFailedSummariesSql, MAX_SUMMARY_RETRIES } = loadTsModule('../src/lib/summaryRetryPolicy.ts');
  const statement = buildResetRetryableFailedSummariesSql(15);

  assert.equal(MAX_SUMMARY_RETRIES, 3);
  assert.match(statement.sql, /summary_status = 'failed'/);
  assert.match(statement.sql, /retry_count < \$1/);
  assert.match(statement.sql, /last_summary_error/);
  assert.match(statement.sql, /summary_status = 'pending'/);
  assert.equal(statement.params[0], 3);
  assert.equal(statement.params[1], 15);
  assert.ok(statement.params.includes('%429%'));
  assert.ok(statement.params.includes('%503%'));
  assert.ok(statement.params.includes('%econnreset%'));
  assert.ok(statement.params.includes('%socket hang up%'));
});

test('retry policy resets stale processing summaries back to pending', () => {
  const { buildResetStuckProcessingSummariesSql } = loadTsModule('../src/lib/summaryRetryPolicy.ts');
  const statement = buildResetStuckProcessingSummariesSql();

  assert.match(statement.sql, /summary_status = 'processing'/);
  assert.match(statement.sql, /INTERVAL '10 minutes'/);
  assert.match(statement.sql, /last_summary_error = 'Reset stale processing state'/);
});

test('summary errors are truncated for database storage', () => {
  const { truncateSummaryError } = loadTsModule('../src/lib/summaryRetryPolicy.ts');
  const message = truncateSummaryError(new Error('x'.repeat(800)));

  assert.equal(message.length, 500);
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadPolicy() {
  const source = readFileSync(resolve(__dirname, '../src/lib/aiRetryPolicy.ts'), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const moduleContext = { exports: {} };
  vm.runInNewContext(outputText, { exports: moduleContext.exports, module: moduleContext });
  return moduleContext.exports;
}

test('AI retry policy classifies transient provider errors', () => {
  const { isRetryableAiError, RETRYABLE_AI_ERROR_SQL_PATTERNS } = loadPolicy();

  for (const message of [
    'Gemini 429: rate limit',
    'Provider 503 service unavailable',
    'socket hang up',
    'ECONNRESET',
    'ETIMEDOUT',
    'request timed out',
    '<!doctype html><html>Cloudflare 524</html>',
  ]) {
    assert.equal(isRetryableAiError(new Error(message)), true, message);
  }

  assert.equal(isRetryableAiError(new Error('safety rejected high-risk content')), false);
  assert.equal(isRetryableAiError(new Error('promotional article skipped')), false);
  assert.ok(RETRYABLE_AI_ERROR_SQL_PATTERNS.includes('%429%'));
  assert.ok(RETRYABLE_AI_ERROR_SQL_PATTERNS.includes('%socket hang up%'));
});

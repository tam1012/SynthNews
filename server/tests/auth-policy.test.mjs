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
    process: { env: {} },
    exports: moduleContext.exports,
    module: moduleContext,
    require: () => ({ recordAuthFailure: () => ({ allowed: true, retryAfterSeconds: 0 }) }),
  });
  return moduleContext.exports;
}

test('settings routes require admin token even for GET', () => {
  const { requiresAdminTokenForRequest } = loadTsModule('../src/lib/auth.ts');

  assert.equal(requiresAdminTokenForRequest('GET', '/api/settings/prompt'), true);
  assert.equal(requiresAdminTokenForRequest('PATCH', '/api/settings/prompt'), true);
  assert.equal(requiresAdminTokenForRequest('GET', '/api/articles'), false);
  assert.equal(requiresAdminTokenForRequest('GET', '/api/articles/fetch-jobs'), true);
  assert.equal(requiresAdminTokenForRequest('GET', '/api/sources'), true);
  assert.equal(requiresAdminTokenForRequest('GET', '/api/sources/src_1'), true);
  assert.equal(requiresAdminTokenForRequest('GET', '/api/sources/public'), false);
  assert.equal(requiresAdminTokenForRequest('GET', '/api/health/live'), false);
});

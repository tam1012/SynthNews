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

test('admin health helpers normalize optional public checks and browser proxy sources', () => {
  const {
    buildAdminWorkItems,
    getBrowserProxySources,
    getPublicChecks,
  } = loadTsModule('../src/pages/admin/adminHelpers.ts');

  assert.deepEqual(Array.from(getPublicChecks(null)), []);
  assert.deepEqual(Array.from(getBrowserProxySources({})), []);
  assert.deepEqual(Array.from(buildAdminWorkItems(null)), []);

  const health = {
    publicChecks: [{ key: 'site', label: 'Public site', status: 'error' }],
    browserProxy: {
      remoteBrowserUrl: 'http://127.0.0.1:9222',
      sources: [{ id: 'reuters', label: 'Reuters', needsBrowser: true }],
    },
  };

  assert.equal(getPublicChecks(health)[0].key, 'site');
  assert.equal(getBrowserProxySources(health)[0].remoteBrowserUrl, 'http://127.0.0.1:9222');
  assert.equal(buildAdminWorkItems(health)[0].label, 'Public site cần kiểm tra');
});

test('admin entry points use explicit AdminHealth typing instead of raw any for health', () => {
  const adminSource = readFileSync(resolve(__dirname, '../src/pages/Admin.tsx'), 'utf8');
  const overviewSource = readFileSync(resolve(__dirname, '../src/pages/admin/OverviewTab.tsx'), 'utf8');
  const helpersSource = readFileSync(resolve(__dirname, '../src/pages/admin/adminHelpers.ts'), 'utf8');
  const apiSource = readFileSync(resolve(__dirname, '../src/services/api.ts'), 'utf8');

  assert.match(helpersSource, /export type AdminHealth =/);
  assert.match(adminSource, /useFetch<AdminHealth>/);
  assert.doesNotMatch(adminSource, /useFetch<any>/);
  assert.match(overviewSource, /health: AdminHealth \| null \| undefined/);
  assert.doesNotMatch(overviewSource, /health: any/);
  assert.match(apiSource, /getHealth: \(\) => request<\{ success: boolean; data: AdminHealth \}>/);
  assert.doesNotMatch(apiSource, /getHealth: \(\) => request<any>\('\/health'\)/);
});

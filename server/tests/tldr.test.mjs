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
    require: (name) => require(name),
  });
  return moduleContext.exports;
}

test('normalizeTldr preserves numeric ranges while removing markdown bullets', () => {
  const { normalizeTldr } = loadTsModule('../src/lib/tldr.ts');

  const tldr = normalizeTldr('- Hà Nội sẽ khởi công khoảng 6.000-7.000 căn nhà từ ngày 25-26/6.');

  assert.equal(tldr, 'Hà Nội sẽ khởi công khoảng 6.000-7.000 căn nhà từ ngày 25-26/6.');
});

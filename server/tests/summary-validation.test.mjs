import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadValidation() {
  const source = readFileSync(resolve(__dirname, '../src/lib/summaryValidation.ts'), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const moduleContext = { exports: {} };
  vm.runInNewContext(outputText, { exports: moduleContext.exports, module: moduleContext });
  return moduleContext.exports;
}

test('assertUsableSummaryOutput returns valid parsed summary', () => {
  const { assertUsableSummaryOutput } = loadValidation();
  const parsed = {
    tldr: 'Tóm tắt hợp lệ',
    summaryShort: 'Ngắn',
    hotScore: 5,
    tags: ['AI'],
    editorialMarkdown: '## Tiêu đề\n' + 'Nội dung đầy đủ '.repeat(20),
    usedStructuredOutput: true,
    isUsable: true,
    translatedTitle: 'Tiêu đề dịch',
  };

  assert.equal(assertUsableSummaryOutput(parsed, 'initial'), parsed);
});

test('assertUsableSummaryOutput throws when repair remains unusable', () => {
  const { assertUsableSummaryOutput } = loadValidation();

  assert.throws(() => assertUsableSummaryOutput({
    tldr: '',
    summaryShort: null,
    hotScore: null,
    tags: [],
    editorialMarkdown: 'quá ngắn',
    usedStructuredOutput: false,
    isUsable: false,
    translatedTitle: null,
  }, 'repair'), /AI summary output unusable after repair/);
});

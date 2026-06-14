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

test('assertUsableSummaryOutput rejects repetitive Vietnam timezone parentheticals', () => {
  const { assertUsableSummaryOutput } = loadValidation();

  assert.throws(() => assertUsableSummaryOutput({
    tldr: 'Lịch phát sóng bị dịch lặp máy móc.',
    summaryShort: 'Một lịch thi đấu có nhiều múi giờ được chuyển đổi lặp lại.',
    hotScore: 4,
    tags: ['Sports'],
    editorialMarkdown: '## Lịch thi đấu\n\nTrận đấu bắt đầu lúc 12:00 CDT (tức khoảng 0:00 ngày hôm sau theo giờ Việt Nam), 13:00 ET (tức khoảng 0:00 ngày hôm sau theo giờ Việt Nam), 10:00 PT (tức khoảng 0:00 ngày hôm sau theo giờ Việt Nam), 18:00 tại Anh (tức khoảng 0:00 ngày hôm sau theo giờ Việt Nam).',
    usedStructuredOutput: true,
    isUsable: true,
    translatedTitle: 'Lịch thi đấu',
  }, 'initial'), /suspicious repetitive Vietnam timezone conversions/);
});

test('assertUsableSummaryOutput rejects repetitive VND conversions for the same amount', () => {
  const { assertUsableSummaryOutput } = loadValidation();

  assert.throws(() => assertUsableSummaryOutput({
    tldr: 'Một khoản vay được nhắc lại nhiều lần.',
    summaryShort: 'Bản dịch lặp quy đổi VNĐ cho cùng một số tiền.',
    hotScore: 4,
    tags: ['Society'],
    editorialMarkdown: '## Diễn biến vụ kiện\n\nÔng Trần vay tổng cộng 270.000 Nhân dân tệ (khoảng 950 triệu VNĐ). Sau khi ông qua đời, khoản vay 270.000 Nhân dân tệ (khoảng 950 triệu VNĐ) bị quá hạn. Ngân hàng yêu cầu người thừa kế hoàn trả khoản nợ gốc 270.000 Nhân dân tệ (khoảng 950 triệu VNĐ), cùng lãi và phí.',
    usedStructuredOutput: true,
    isUsable: true,
    translatedTitle: 'Vụ kiện khoản vay',
  }, 'initial'), /suspicious repetitive VND conversions/);
});

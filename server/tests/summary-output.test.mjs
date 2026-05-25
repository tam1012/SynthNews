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

test('parse structured JSON summary output into article metadata and markdown', () => {
  const { parseAiSummaryOutput } = loadTsModule('../src/lib/summaryOutput.ts');
  const parsed = parseAiSummaryOutput(JSON.stringify({
    tldr: 'Tin chính trong một câu.',
    summary_short: 'Bản tóm tắt ngắn.',
    hot_score: 8,
    tags: ['AI', 'Tech', 'Unknown'],
    editorial_markdown: '## Heading\n\nNội dung sâu.',
  }), ['AI', 'Tech']);

  assert.equal(parsed.tldr, 'Tin chính trong một câu.');
  assert.equal(parsed.summaryShort, 'Bản tóm tắt ngắn.');
  assert.equal(parsed.hotScore, 8);
  assert.deepEqual(Array.from(parsed.tags), ['AI', 'Tech']);
  assert.equal(parsed.editorialMarkdown, '## Heading\n\nNội dung sâu.');
  assert.equal(parsed.usedStructuredOutput, true);
  assert.equal(parsed.isUsable, false);
});

test('parse legacy markdown summary output and keep existing TLDR behavior', () => {
  const { parseAiSummaryOutput } = loadTsModule('../src/lib/summaryOutput.ts');
  const raw = '<tldr>\nLegacy TLDR.\n</tldr>\n\n## Legacy\n\nBody';
  const parsed = parseAiSummaryOutput(raw, ['AI']);

  assert.equal(parsed.tldr, 'Legacy TLDR.');
  assert.equal(parsed.summaryShort, null);
  assert.equal(parsed.hotScore, null);
  assert.deepEqual(Array.from(parsed.tags), []);
  assert.equal(parsed.editorialMarkdown, '## Legacy\n\nBody');
  assert.equal(parsed.usedStructuredOutput, false);
  assert.equal(parsed.isUsable, false);
});

test('clamp score and normalize allowed tags from structured output', () => {
  const { parseAiSummaryOutput } = loadTsModule('../src/lib/summaryOutput.ts');
  const parsed = parseAiSummaryOutput(JSON.stringify({
    tldr: 'TLDR',
    summary_short: '',
    hot_score: 99,
    tags: [' ai ', 'SECURITY', 'crypto', 'bad'],
    editorial_markdown: 'Body',
  }), ['AI', 'Security', 'Crypto']);

  assert.equal(parsed.hotScore, 10);
  assert.deepEqual(Array.from(parsed.tags), ['AI', 'Security', 'Crypto']);
  assert.equal(parsed.summaryShort, null);
  assert.equal(parsed.isUsable, false);
});

test('mark long structured output with TLDR as usable', () => {
  const { parseAiSummaryOutput } = loadTsModule('../src/lib/summaryOutput.ts');
  const parsed = parseAiSummaryOutput(JSON.stringify({
    tldr: 'Đây là tóm tắt chính.',
    summary_short: 'Bản tóm tắt ngắn.',
    hot_score: 7,
    tags: ['AI'],
    editorial_markdown: '## Bối cảnh chính\n\nNội dung phân tích đủ dài để người đọc hiểu bối cảnh, các bên liên quan, hệ quả và lý do sự kiện này đáng chú ý trong thực tế vận hành sản phẩm công nghệ.',
  }), ['AI']);

  assert.equal(parsed.isUsable, true);
});

test('parse legacy structured keys from older AI outputs', () => {
  const { parseAiSummaryOutput } = loadTsModule('../src/lib/summaryOutput.ts');
  const parsed = parseAiSummaryOutput(JSON.stringify({
    tldr: 'Tin chính.',
    summaryShort: 'Bản ngắn.',
    hotScore: '9',
    tags: ['tech'],
    editorialmarkdown: '## Bối cảnh chính\n\nNội dung phân tích đủ dài để repair metadata cho các bài cũ từng lưu JSON sai key, giúp feed có lại tóm tắt ngắn, điểm nóng và tag mà không cần gọi AI lần nữa.',
  }), ['Tech']);

  assert.equal(parsed.summaryShort, 'Bản ngắn.');
  assert.equal(parsed.hotScore, 9);
  assert.deepEqual(Array.from(parsed.tags), ['Tech']);
  assert.match(parsed.editorialMarkdown, /repair metadata/);
});

test('parse structured JSON summary with translated title', () => {
  const { parseAiSummaryOutput } = loadTsModule('../src/lib/summaryOutput.ts');
  const parsed = parseAiSummaryOutput(JSON.stringify({
    translated_title: 'Tiêu đề tiếng Việt',
    tldr: 'Tin chính trong một câu.',
    summary_short: 'Bản tóm tắt ngắn.',
    hot_score: 8,
    tags: ['AI'],
    editorial_markdown: '## Heading\n\nNội dung phân tích rất dài và chi tiết để đảm bảo bài viết khả dụng cho người đọc xem tóm tắt thông tin từ AI. Chúng ta cần viết dài hơn một chút để vượt qua 120 ký tự bắt buộc trong logic kiểm tra.',
  }), ['AI']);

  assert.equal(parsed.translatedTitle, 'Tiêu đề tiếng Việt');
  assert.equal(parsed.isUsable, true);
});

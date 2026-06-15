import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadTsModule(relativePath, requireMap = {}) {
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
    console,
    process: { env: {} },
    require: (name) => {
      if (Object.hasOwn(requireMap, name)) return requireMap[name];
      throw new Error(`Unexpected require: ${name}`);
    },
  });
  return moduleContext.exports;
}

function validSummary(overrides = {}) {
  return JSON.stringify({
    translated_title: 'Tieu de da sua',
    tldr: 'Tom tat hop le cho bai viet.',
    summary_short: 'Ban tom tat ngan hop le.',
    hot_score: 5,
    tags: ['Sports'],
    editorial_markdown: '## Noi dung\n\n' + 'Doan noi dung hop le va du dai de vuot qua nguong kiem tra. '.repeat(5),
    ...overrides,
  });
}

function loadSummarizerWithAiResponses(responses) {
  const prompts = [];
  const promptConfig = {
    output_language: 'Vietnamese',
    allowed_tags: ['Sports', 'World', 'Entertainment'],
    topic_priorities: ['Sports'],
    digest_headings: [],
    custom_context: '',
  };
  const summaryOutput = loadTsModule('../src/lib/summaryOutput.ts');
  const summaryValidation = loadTsModule('../src/lib/summaryValidation.ts');

  const mod = loadTsModule('../src/services/summarizer.ts', {
    '../db/index.js': {
      query: async () => ({ rows: [] }),
      getMany: async () => [],
    },
    '../lib/utils.js': {
      generateId: () => 'id_test',
      truncate: (value, max) => String(value || '').slice(0, max),
    },
    '../lib/tldr.js': {
      normalizeTldr: (value) => value,
    },
    '../lib/promptConfig.js': {},
    '../lib/summaryRetryPolicy.js': {
      truncateSummaryError: (err) => String(err?.message || err).slice(0, 500),
    },
    '../lib/summaryOutput.js': summaryOutput,
    '../lib/summaryValidation.js': summaryValidation,
    '../lib/promoFilter.js': {
      isPromoTitle: () => false,
      buildPromoClassifyPrompt: () => '',
      isPromoClassification: () => false,
      shouldRunPromoClassification: () => false,
    },
    './ai-client.js': {
      callAi: async (prompt) => {
        prompts.push(prompt);
        const next = responses.shift();
        if (next instanceof Error) throw next;
        return next;
      },
    },
    './prompt-settings.js': {
      getPromptConfig: async () => promptConfig,
    },
    './post-summarize-cluster.js': {
      maybeClusterAfterSummarize: async () => {},
    },
  });

  return { ...mod, prompts, promptConfig };
}

test('summarizeArticle repairs usable output that fails repetitive timezone validation', async () => {
  const repetitiveOutput = validSummary({
    tldr: 'Lich thi dau bi lap quy doi gio.',
    summary_short: 'Bai viet co nhieu moc gio bi quy doi lap lai.',
    editorial_markdown: '## Lich thi dau\n\nTran dau bat dau luc 12:00 CDT (tức khoảng 0:00 ngày hôm sau theo giờ Việt Nam), 13:00 ET (tức khoảng 0:00 ngày hôm sau theo giờ Việt Nam), 10:00 PT (tức khoảng 0:00 ngày hôm sau theo giờ Việt Nam), 18:00 tai Anh (tức khoảng 0:00 ngày hôm sau theo giờ Việt Nam).',
  });
  const repairedOutput = validSummary({
    tldr: 'Duc thang dam Curacao trong tran ra quan.',
    editorial_markdown: '## Duc ap dao\n\nDuc thang Curacao trong tran dau mot chieu tai Houston. Cac moc gio phat song duoc rut gon, voi thoi diem chinh tuong duong sang ngay hom sau tai Viet Nam.',
  });
  const { summarizeArticle, prompts, promptConfig } = loadSummarizerWithAiResponses([repetitiveOutput, repairedOutput]);

  const result = await summarizeArticle({
    id: 'art_timezones',
    title: "Germany crushes debutant Curacao in World Cup's first big blowout",
    raw_excerpt: '',
    raw_content: 'Match report. '.repeat(80),
    language: 'en',
    source_name: 'MSN',
  }, promptConfig);

  assert.equal(result.tldr, 'Duc thang dam Curacao trong tran ra quan.');
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /Convert the following AI summary/);
});

test('summarizeArticle sends refusal-shaped AI output to safe fallback instead of repair', async () => {
  const refusal = "I'm sorry, but I can't assist with summarizing sexual content involving a minor.";
  const safeOutput = validSummary({
    translated_title: 'Chu de Reddit nhay cam bi xu ly an toan',
    tldr: 'Bai Reddit co noi dung nhay cam nen duoc tom tat o muc khai quat.',
    tags: ['Entertainment'],
    editorial_markdown: '## Xu ly an toan\n\nChu de Reddit de cap den mot giai thoai nhay cam ve nguoi noi tieng va tre vi thanh nien. Ban tom tat giu o muc khai quat, khong lap lai chi tiet nhay cam, tap trung vao boi canh cong dong va ly do noi dung nay co the gay tranh cai.',
  });
  const { summarizeArticle, prompts, promptConfig } = loadSummarizerWithAiResponses([refusal, safeOutput]);

  const result = await summarizeArticle({
    id: 'art_refusal',
    title: '[r/AskProgramming] How do researchers discuss malware safely?',
    raw_excerpt: 'A forum thread about safely discussing malware research.',
    raw_content: 'Forum thread with sensitive cybersecurity discussion. '.repeat(80),
    language: 'en',
    source_name: 'Reddit r/AskProgramming',
  }, promptConfig);

  assert.equal(result.tldr, 'Bai Reddit co noi dung nhay cam nen duoc tom tat o muc khai quat.');
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /cautious news editor/);
});

test('summarizeArticle skips high-risk minor sexual forum topics before calling AI', async () => {
  const { summarizeArticle, SummarySkippedError, prompts, promptConfig } = loadSummarizerWithAiResponses([
    validSummary(),
  ]);

  await assert.rejects(
    () => summarizeArticle({
      id: 'art_sensitive_forum',
      title: '[r/todayilearned] TIL that a celebrity dated a child',
      raw_excerpt: 'TIL that a celebrity dated a child',
      raw_content: 'Forum thread with sensitive celebrity discussion. '.repeat(80),
      language: 'en',
      source_name: 'Reddit r/todayilearned',
    }, promptConfig),
    (err) => err instanceof SummarySkippedError && /sensitive minor sexual forum topic/i.test(err.message)
  );
  assert.equal(prompts.length, 0);
});

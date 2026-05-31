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

test('reader personalization filters muted topics before bookmark-only mode', () => {
  const { filterPersonalizedArticles } = loadTsModule('../src/pages/home/homeHelpers.ts');

  const articles = [
    { id: 'a1', source_name: 'Reuters RSS', tags: ['AI', 'Policy'] },
    { id: 'a2', source_name: 'VOZ', tags: ['Gaming'] },
    { id: 'a3', source_name: 'TechCrunch RSS', tags: ['Startup'] },
  ];

  assert.deepEqual(
    filterPersonalizedArticles(articles, {
      mutedTags: ['policy'],
      bookmarkedArticleIds: ['a2', 'a3'],
      bookmarkedOnly: false,
    }).map((article) => article.id),
    ['a2', 'a3']
  );

  assert.deepEqual(
    filterPersonalizedArticles(articles, {
      mutedTags: [],
      bookmarkedArticleIds: ['a2', 'a3'],
      bookmarkedOnly: true,
    }).map((article) => article.id),
    ['a2', 'a3']
  );
});

test('reader preference helpers normalize keys and toggle ids deterministically', () => {
  const {
    getArticleTopicPreferenceKeys,
    toggleListValue,
  } = loadTsModule('../src/pages/home/homeHelpers.ts');

  assert.deepEqual(Array.from(getArticleTopicPreferenceKeys({ tags: [' AI ', 'AI', '', 'Security'] })), ['ai', 'security']);
  assert.deepEqual(Array.from(toggleListValue(['a', 'b'], 'b')), ['a']);
  assert.deepEqual(Array.from(toggleListValue(['a'], 'b')), ['b', 'a']);
  assert.deepEqual(Array.from(toggleListValue(['Article_One'], 'ID_MixedCase')), ['ID_MixedCase', 'Article_One']);
});

test('digest mode markdown returns compact and deep variants from the same digest', () => {
  const { buildDigestModeMarkdown } = loadTsModule('../src/pages/home/homeHelpers.ts');
  const digest = {
    body_markdown: '## Chính\n\nĐây là phần mở đầu rất dài về thị trường AI và chính sách công nghệ. '.repeat(20),
    articles: [
      { title: 'Bài một', url: 'https://example.com/1', source_name: 'Reuters RSS' },
      { title: 'Bài hai', url: 'https://example.com/2', source_name: 'TechCrunch RSS' },
    ],
  };

  const shortBody = buildDigestModeMarkdown(digest, 'short');
  const standardBody = buildDigestModeMarkdown(digest, 'standard');
  const deepBody = buildDigestModeMarkdown(digest, 'deep');

  assert.match(shortBody, /## Bản ngắn/);
  assert.match(shortBody, /### Tin chính/);
  assert.ok(shortBody.length < standardBody.length);
  assert.equal(standardBody, digest.body_markdown.trim());
  assert.match(deepBody, /## Nguồn bài trong bản tin/);
  assert.match(deepBody, /\[Bài một\]\(https:\/\/example\.com\/1\)/);
});

test('reader UI wires bookmark mute controls and digest mode selector', () => {
  const homeSource = readFileSync(resolve(__dirname, '../src/pages/Home.tsx'), 'utf8');
  const feedItemSource = readFileSync(resolve(__dirname, '../src/pages/home/FeedItem.tsx'), 'utf8');
  const detailSource = readFileSync(resolve(__dirname, '../src/pages/home/ArticleDetail.tsx'), 'utf8');
  const digestSource = readFileSync(resolve(__dirname, '../src/pages/home/DigestTab.tsx'), 'utf8');

  assert.match(homeSource, /bookmarkedOnly/);
  assert.match(homeSource, /filterPersonalizedArticles/);
  assert.match(homeSource, /mutedTags/);
  assert.doesNotMatch(homeSource, /mutedSourceKeys/);
  assert.match(feedItemSource, /onToggleBookmark/);
  assert.doesNotMatch(feedItemSource, /onMuteSource/);
  assert.match(detailSource, /onToggleBookmark/);
  assert.doesNotMatch(detailSource, /onMuteSource/);
  assert.match(digestSource, /DigestMode/);
  assert.match(digestSource, /buildDigestModeMarkdown/);
});

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

test('article deep links keep the detail pane visible while article data loads', () => {
  const { getReaderLoadingState, shouldShowDetailPane } = loadTsModule('../src/pages/homeUx.ts');

  assert.equal(getReaderLoadingState({ isFeedLoading: true, hasArticleDeepLink: true }), 'split');
  assert.equal(shouldShowDetailPane({ tab: 'news', hasSelectedArticle: false, hasArticleDeepLink: true }), true);
});

test('non-article loads still use the compact full feed skeleton', () => {
  const { getReaderLoadingState, shouldShowDetailPane } = loadTsModule('../src/pages/homeUx.ts');

  assert.equal(getReaderLoadingState({ isFeedLoading: true, hasArticleDeepLink: false }), 'feed-only');
  assert.equal(shouldShowDetailPane({ tab: 'news', hasSelectedArticle: false, hasArticleDeepLink: false }), false);
});

test('digest route keeps the right pane visible without opening article detail state', () => {
  const { shouldShowDetailPane, shouldShowRightPane } = loadTsModule('../src/pages/homeUx.ts');

  assert.equal(shouldShowDetailPane({ tab: 'digest', hasSelectedArticle: false, hasArticleDeepLink: false }), false);
  assert.equal(shouldShowRightPane({ tab: 'digest', hasSelectedArticle: false, hasArticleDeepLink: false }), true);
});

test('scroll-to-top affordance appears only for long feed scroll without detail pane', () => {
  const { shouldShowScrollTopButton } = loadTsModule('../src/pages/homeUx.ts');

  assert.equal(shouldShowScrollTopButton(421, false), true);
  assert.equal(shouldShowScrollTopButton(420, false), false);
  assert.equal(shouldShowScrollTopButton(900, true), false);
});

test('empty feed message distinguishes offline cache and filtered views', () => {
  const { getEmptyFeedMessage } = loadTsModule('../src/pages/homeUx.ts');

  assert.equal(
    getEmptyFeedMessage({ isOfflineCache: true, hasFilter: false, tab: 'news' }),
    'Không có dữ liệu đã lưu cho bộ lọc này.'
  );
  assert.equal(
    getEmptyFeedMessage({ isOfflineCache: false, hasFilter: true, tab: 'reddit' }),
    'Không có tin trong nguồn/tab này.'
  );
  assert.equal(
    getEmptyFeedMessage({ isOfflineCache: false, hasFilter: false, tab: 'news' }),
    'Hệ thống đang cào và tóm tắt tin. Hãy quay lại sau.'
  );
});

test('feed articles are constrained to the selected local date before rendering', () => {
  const { filterArticlesBySelectedDate } = loadTsModule('../src/pages/homeUx.ts');
  const articles = [
    { id: 'new', local_date: '2026-05-06', published_at: '2026-05-05T18:00:00.000Z' },
    { id: 'old', local_date: '2026-05-05', published_at: '2026-05-05T23:59:00.000Z' },
    { id: 'fallback', published_at: '2026-05-06T00:00:00.000Z' },
    { id: 'missing' },
  ];

  assert.deepEqual(filterArticlesBySelectedDate(articles, '2026-05-06').map((article) => article.id), ['new', 'fallback']);
  assert.deepEqual(filterArticlesBySelectedDate(articles, null).map((article) => article.id), ['new', 'old', 'fallback', 'missing']);
});

test('date deep links map ddmmyyyy paths to local ISO dates', () => {
  const { formatDateDeepLink, parseDateDeepLinkPath } = loadTsModule('../src/pages/homeUx.ts');

  assert.equal(parseDateDeepLinkPath('/28052026'), '2026-05-28');
  assert.equal(parseDateDeepLinkPath('/29022024'), '2024-02-29');
  assert.equal(parseDateDeepLinkPath('/31022026'), null);
  assert.equal(parseDateDeepLinkPath('/news'), null);
  assert.equal(formatDateDeepLink('2026-05-28'), '/28052026');
});

test('feed item helpers expose fresh and visible tag state', () => {
  const { getVisibleArticleTags, isArticleFresh } = loadTsModule('../src/pages/home/homeHelpers.ts');
  const now = Date.parse('2026-05-29T08:00:00.000Z');

  assert.equal(isArticleFresh({ published_at: '2026-05-29T03:30:00.000Z' }, now), true);
  assert.equal(isArticleFresh({ published_at: '2026-05-29T00:00:00.000Z' }, now), false);
  assert.equal(isArticleFresh({ published_at: 'invalid' }, now), false);
  assert.deepEqual(
    Array.from(getVisibleArticleTags({ tags: ['AI', ' Kinh tế ', '', 'AI', 'Chính sách'] }, 3)),
    ['AI', 'Kinh tế', 'Chính sách']
  );
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function readCssBundle() {
  const stylesDir = resolve(__dirname, '../src/styles');
  const globalCss = readFileSync(resolve(stylesDir, 'global.css'), 'utf8');
  return globalCss.replace(/@import '\.\/(.+?)';/g, (_, file) => readFileSync(resolve(stylesDir, file), 'utf8'));
}

test('global stylesheet imports split CSS modules in cascade order', () => {
  const css = readFileSync(resolve(__dirname, '../src/styles/global.css'), 'utf8');
  const importedFiles = Array.from(css.matchAll(/^@import '\.\/(.+?)';$/gm), match => match[1]);

  assert.deepEqual(importedFiles, [
    'tokens.css',
    'base.css',
    'sidebar.css',
    'header.css',
    'components.css',
    'home.css',
    'sources.css',
    'admin.css',
    'settings-sheet.css',
  ]);
});

test('desktop split feed tabs scroll within the left pane instead of overflowing it', () => {
  const css = readCssBundle();
  const splitTabsRule = css.match(/\.split-left \.feed-tabs\s*\{([^}]+)\}/)?.[1] || '';
  const feedTabRule = css.match(/\.feed-tab\s*\{([^}]+)\}/)?.[1] || '';

  assert.match(splitTabsRule, /justify-content:\s*flex-start/);
  assert.match(splitTabsRule, /overflow-x:\s*auto/);
  assert.match(feedTabRule, /white-space:\s*nowrap/);
});

test('dark theme uses restrained neutral dark tokens', () => {
  const css = readCssBundle();
  const darkThemeRule = css.match(/\[data-theme="dark"\]\s*\{([^}]+)\}/)?.[1] || '';

  assert.match(darkThemeRule, /--color-bg:\s*#161819/);
  assert.match(darkThemeRule, /--color-bg-card:\s*#1e2022/);
  assert.match(darkThemeRule, /--color-accent:\s*#9ec5ff/);
  assert.match(darkThemeRule, /--color-border:\s*#363a3e/);
});

test('split feed toolbar keeps compact tabs separate from the filter button on narrow panes', () => {
  const css = readCssBundle();
  const toolbarTabsRule = css.match(/\.split-feed-toolbar \.feed-tabs\s*\{([^}]+)\}/)?.[1] || '';
  const toolbarTabRule = css.match(/\.split-feed-toolbar \.feed-tab\s*\{([^}]+)\}/)?.[1] || '';

  assert.match(toolbarTabsRule, /justify-content:\s*flex-start/);
  assert.match(toolbarTabsRule, /overflow-x:\s*auto/);
  assert.match(toolbarTabRule, /padding:\s*6px 8px/);
  assert.match(toolbarTabRule, /font-size:\s*0\.82rem/);
});

test('desktop split view widens reader without changing feed column width', () => {
  const css = readCssBundle();

  assert.match(css, /@media \(min-width:\s*1100px\)\s*\{[\s\S]*body\.split-view-active\s*\{[\s\S]*overflow:\s*hidden/);
  assert.match(css, /body\.split-view-active \.container-fluid\s*\{[\s\S]*max-width:\s*100%[\s\S]*padding:\s*0/);
  assert.match(css, /\.home-split-layout\s*\{[\s\S]*width:\s*100%/);
  assert.match(css, /@media \(min-width:\s*1100px\)\s*\{[\s\S]*\.split-left\s*\{[\s\S]*flex:\s*0 1 360px[\s\S]*max-width:\s*360px/);
  assert.match(css, /@media \(min-width:\s*1200px\)\s*\{[\s\S]*\.split-left\s*\{[\s\S]*flex:\s*0 1 400px[\s\S]*max-width:\s*400px/);
});

test('mobile reader exposes refresh row and floating scroll-to-top affordance styles', () => {
  const css = readCssBundle();
  const homeSource = readFileSync(resolve(__dirname, '../src/pages/Home.tsx'), 'utf8');

  assert.match(css, /\.feed-refresh-row\s*\{/);
  assert.match(css, /\.scroll-top-button\s*\{/);
  assert.match(homeSource, /className="feed-refresh-row"/);
  assert.match(homeSource, /className="scroll-top-button"/);
});

test('mobile feed uses a fixed bottom tab bar while digest keeps the feed hidden', () => {
  const css = readCssBundle();
  const homeSource = readFileSync(resolve(__dirname, '../src/pages/Home.tsx'), 'utf8');

  assert.doesNotMatch(homeSource, /feed-tabs visible-on-mobile-only/);
  assert.doesNotMatch(css, /\.visible-on-mobile-only\.feed-tabs\s*\{/);
  assert.match(homeSource, /tab !== 'digest' && \(\s*<div className="feed-container">/);
  assert.match(css, /\.split-feed-toolbar \.toolbar-tabs-row\s*\{[\s\S]*position:\s*fixed[\s\S]*bottom:\s*0/);
  assert.match(css, /\.split-feed-toolbar \.toolbar-tabs-row\s*\{[\s\S]*justify-content:\s*center/);
});

test('mobile feed and detail styles prioritize clean reading', () => {
  const css = readCssBundle();
  const homeSource = readFileSync(resolve(__dirname, '../src/pages/Home.tsx'), 'utf8');
  const detailSource = readFileSync(resolve(__dirname, '../src/pages/home/ArticleDetail.tsx'), 'utf8');
  const feedItemSource = readFileSync(resolve(__dirname, '../src/pages/home/FeedItem.tsx'), 'utf8');

  assert.match(css, /\.feed-item-body\s*\{[\s\S]*display:\s*block/);
  assert.match(css, /\.detail-source-link\s*\{/);
  assert.match(css, /\.detail-reading-nav\s*\{/);
  assert.match(css, /\.detail-reading-nav-btn\s*\{/);
  assert.match(css, /height:\s*100dvh/);
  assert.match(css, /\.detail-mobile-header\s*\{[\s\S]*display:\s*none/);
  assert.match(css, /padding:\s*26px 0 12px/);
  assert.match(css, /touch-action:\s*none/);
  assert.match(css, /\.feed-item-title\s*\{[\s\S]*font-size:\s*1\.02rem/);
  assert.match(css, /\.detail-title-editorial\s*\{[\s\S]*font-size:\s*clamp\(1\.75rem, 3\.4vw, 2\.1rem\)/);
  assert.match(detailSource, /startedOnPullBarRef/);
  assert.match(css, /--safe-bottom:\s*env\(safe-area-inset-bottom/);
  assert.match(homeSource, /Đang cập nhật tin mới/);
  assert.match(feedItemSource, /feed-item-state-badge/);
  assert.match(feedItemSource, /feed-item-tags/);
  assert.match(css, /\.feed-item-state-badge\s*\{/);
  assert.match(css, /\.feed-item-tags\s*\{/);
});

test('service worker unregisters legacy caches and reloads open clients', () => {
  const serviceWorker = readFileSync(resolve(__dirname, '../public/sw.js'), 'utf8');

  assert.match(serviceWorker, /self\.registration\.unregister\(\)/);
  assert.match(serviceWorker, /key\.startsWith\('synthnews-'\)/);
  assert.match(serviceWorker, /client\.navigate\(client\.url\)/);
});

test('feed uses server-side tab pagination and exposes load-more control', () => {
  const homeSource = readFileSync(resolve(__dirname, '../src/pages/Home.tsx'), 'utf8');
  const apiSource = readFileSync(resolve(__dirname, '../src/services/api.ts'), 'utf8');

  assert.match(apiSource, /type ArticleFeedTab = 'all' \| 'news' \| 'tech' \| 'voz' \| 'reddit'/);
  assert.match(apiSource, /feedTab\?: ArticleFeedTab/);
  assert.match(homeSource, /feedTab: tab === 'digest' \? 'all' : tab/);
  assert.match(homeSource, /handleLoadMoreArticles/);
  assert.match(homeSource, /Tải thêm bài cũ/);
});

test('feed omits hot ranking controls for a simpler toolbar', () => {
  const homeSource = readFileSync(resolve(__dirname, '../src/pages/Home.tsx'), 'utf8');
  const css = readCssBundle();

  assert.doesNotMatch(homeSource, /Tin nóng/);
  assert.doesNotMatch(homeSource, /sort: feedSort/);
  assert.doesNotMatch(css, /\.feed-sort-toggle\s*\{/);
});

test('article detail supports keyboard arrow navigation', () => {
  const homeSource = readFileSync(resolve(__dirname, '../src/pages/Home.tsx'), 'utf8');

  assert.match(homeSource, /event\.key === 'ArrowLeft'/);
  assert.match(homeSource, /handlePrevArticle\(\)/);
  assert.match(homeSource, /event\.key === 'ArrowRight'/);
  assert.match(homeSource, /handleNextArticle\(\)/);
  assert.match(homeSource, /input, textarea, select, \[contenteditable="true"\]/);
});

test('MobileBottomNav uses end prop on "Tất cả" to prevent date-prefix double-active', () => {
  const source = readFileSync(resolve(__dirname, '../src/components/MobileBottomNav.tsx'), 'utf8');

  // NavLink for "Tất cả" must carry end={item.label === 'Tất cả'}
  assert.match(source, /end=\{item\.label === 'Tất cả'\}/);
  // The custom isActive still handles the exact-match logic
  assert.match(source, /isActive\(item\.href\)/);
});

test('Sidebar uses end prop on "All News" to prevent date-prefix double-active', () => {
  const source = readFileSync(resolve(__dirname, '../src/components/Sidebar.tsx'), 'utf8');

  // NavLink for "All News" must carry end={item.name === 'All News'}
  assert.match(source, /end=\{item\.name === 'All News'\}/);
  // The custom isNavActive still handles the exact-match logic
  assert.match(source, /isNavActive\(item\.href\)/);
});

test('mobile digest hides left history panel; desktop split keeps it', () => {
  const css = readCssBundle();

  // On mobile (max-width: 1099px), .split-left.digest-mode must be hidden
  const mobileBlock = css.match(/@media\s*\(max-width:\s*1099px\)\s*\{[\s\S]*?\.split-left\.digest-mode\s*\{([^}]+)\}/);
  assert.ok(mobileBlock, 'mobile digest-mode rule must exist inside max-width:1099px');
  assert.match(mobileBlock[1], /display:\s*none/);
  assert.doesNotMatch(mobileBlock[1], /display:\s*block/);

  // On desktop (min-width: 1100px), .split-left exists as a flex child for the split layout
  const desktopSplit = css.match(/@media\s*\(min-width:\s*1100px\)\s*\{[\s\S]*?\.split-left\s*\{([^}]+)\}/);
  assert.ok(desktopSplit, 'desktop split-left rule must exist inside min-width:1100px');
  assert.match(desktopSplit[1], /flex:\s*0 1 360px/);
});

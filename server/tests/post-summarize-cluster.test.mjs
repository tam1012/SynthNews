import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

const __dirname = dirname(fileURLToPath(import.meta.url));

const realSimilarity = (() => {
  const source = readFileSync(resolve(__dirname, '../src/lib/similarity.ts'), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const ctx = { exports: {} };
  vm.runInNewContext(outputText, { exports: ctx.exports, module: ctx, require: (n) => require(n) });
  return ctx.exports;
})();

function loadTsModule(relativePath, stubs = {}) {
  const source = readFileSync(resolve(__dirname, relativePath), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const moduleContext = { exports: {} };
  const merged = {
    '../lib/similarity.js': realSimilarity,
    ...stubs,
  };
  vm.runInNewContext(outputText, {
    exports: moduleContext.exports,
    module: moduleContext,
    require: (name) => {
      if (merged[name]) return merged[name];
      throw new Error(`Unexpected require ${name}`);
    },
    console,
  });
  return moduleContext.exports;
}

function makeDb({ article, candidates }) {
  const calls = [];
  return {
    calls,
    getOne: async (sql, params) => {
      calls.push({ kind: 'getOne', sql, params });
      if (/FROM articles WHERE id = \$1/.test(sql) && params[0] === article.id) return article;
      return null;
    },
    getMany: async (sql, params) => {
      calls.push({ kind: 'getMany', sql, params });
      return candidates;
    },
    query: async (sql, params) => {
      calls.push({ kind: 'query', sql, params });
      return { rowCount: 1 };
    },
  };
}

test('post-cluster: zh leader + en candidate clusters via translated_title', async () => {
  const article = {
    id: 'art_en',
    url: 'https://reuters.com/world/russia-warns-foreigners',
    title: 'Russia threatens more Kyiv strikes and tells foreign nationals to leave',
    translated_title: 'Nga đe dọa thêm các đợt không kích Kyiv, yêu cầu công dân nước ngoài rời đi',
    summary_short: 'Nga cảnh báo công dân nước ngoài và nhân viên ngoại giao rời Kyiv, đe dọa tấn công các trung tâm ra quyết định.',
    image_url: null,
    parent_article_id: null,
  };
  const candidates = [
    {
      id: 'art_zh',
      url: 'https://cna.com.tw/news/aopl/202605250125.aspx',
      title: '俄警告外國人速離基輔 揚言將轟炸決策中心',
      translated_title: 'Nga cảnh báo người nước ngoài rời Kyiv, đe dọa oanh tạc các trung tâm ra quyết định',
      summary_short: 'Nga đã cảnh báo người nước ngoài và nhân viên ngoại giao rời Kyiv, đồng thời tuyên bố sẽ tấn công các trung tâm ra quyết định.',
      image_url: null,
    },
  ];
  const db = makeDb({ article, candidates });

  const mod = loadTsModule('../src/services/post-summarize-cluster.ts', {
    '../db/index.js': { getOne: db.getOne, getMany: db.getMany, query: db.query },
  });
  const result = await mod.maybeClusterAfterSummarize('art_en');

  assert.equal(result.attached, true, `Expected to attach, got reason=${result.reason}`);
  assert.equal(result.parentId, 'art_zh');
  const updates = db.calls.filter((c) => c.kind === 'query');
  assert.equal(updates.length, 2, 'should update self + flatten followers');
  assert.equal(updates[0].params[0], 'art_zh');
  assert.equal(updates[0].params[2], 'art_en');
});

test('post-cluster: skips if article already a follower', async () => {
  const article = {
    id: 'art_x',
    url: 'https://example.com/a',
    title: 'X',
    translated_title: 'X tiếng Việt',
    summary_short: 'short',
    image_url: null,
    parent_article_id: 'art_existing_leader',
  };
  const db = makeDb({ article, candidates: [] });
  const mod = loadTsModule('../src/services/post-summarize-cluster.ts', {
    '../db/index.js': { getOne: db.getOne, getMany: db.getMany, query: db.query },
  });
  const result = await mod.maybeClusterAfterSummarize('art_x');
  assert.equal(result.attached, false);
  assert.equal(result.reason, 'already-follower');
  assert.equal(db.calls.filter((c) => c.kind === 'query').length, 0);
});

test('post-cluster: skips if translated_title missing', async () => {
  const article = {
    id: 'art_x',
    url: 'https://example.com/a',
    title: 'X',
    translated_title: null,
    summary_short: 'short',
    image_url: null,
    parent_article_id: null,
  };
  const db = makeDb({ article, candidates: [] });
  const mod = loadTsModule('../src/services/post-summarize-cluster.ts', {
    '../db/index.js': { getOne: db.getOne, getMany: db.getMany, query: db.query },
  });
  const result = await mod.maybeClusterAfterSummarize('art_x');
  assert.equal(result.reason, 'no-translated-title');
});

test('post-cluster: skips forum URLs', async () => {
  const article = {
    id: 'art_voz',
    url: 'https://voz.vn/t/123',
    title: 'VOZ thread',
    translated_title: 'VOZ thread translated',
    summary_short: 'short',
    image_url: null,
    parent_article_id: null,
  };
  const db = makeDb({ article, candidates: [] });
  const mod = loadTsModule('../src/services/post-summarize-cluster.ts', {
    '../db/index.js': { getOne: db.getOne, getMany: db.getMany, query: db.query },
  });
  const result = await mod.maybeClusterAfterSummarize('art_voz');
  assert.equal(result.reason, 'forum-skip');
});

test('post-cluster: unrelated translated_titles do not cluster', async () => {
  const article = {
    id: 'art_a',
    url: 'https://example.com/a',
    title: 'Apple ra mắt iPhone',
    translated_title: 'Apple công bố iPhone 17 với chip M5 và camera 48MP',
    summary_short: 'Apple ra mắt iPhone 17 tại sự kiện thường niên ở California.',
    image_url: null,
    parent_article_id: null,
  };
  const candidates = [
    {
      id: 'art_b',
      url: 'https://example.com/b',
      title: 'Russia warns Kyiv',
      translated_title: 'Nga đe dọa thêm các đợt không kích Kyiv, yêu cầu công dân nước ngoài rời đi',
      summary_short: 'Nga cảnh báo công dân nước ngoài và nhân viên ngoại giao rời Kyiv.',
      image_url: null,
    },
  ];
  const db = makeDb({ article, candidates });
  const mod = loadTsModule('../src/services/post-summarize-cluster.ts', {
    '../db/index.js': { getOne: db.getOne, getMany: db.getMany, query: db.query },
  });
  const result = await mod.maybeClusterAfterSummarize('art_a');
  assert.equal(result.attached, false);
  assert.equal(result.reason, 'no-similar');
});

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

test('article filters add tag and minimum score SQL predicates', () => {
  const { buildArticleListFilters } = loadTsModule('../src/lib/articleFilters.ts');
  const result = buildArticleListFilters({
    sourceId: 'src_1',
    status: 'done',
    date: '2026-05-04',
    tag: 'AI',
    minScore: '7',
  });

  assert.match(result.where, /a\.source_id = \$1/);
  assert.match(result.where, /a\.summary_status = \$2/);
  assert.match(result.where, /DATE\(COALESCE\(a\.published_at, a\.created_at\)/);
  assert.match(result.where, /\$4 = ANY\(a\.tags\)/);
  assert.match(result.where, /a\.hot_score >= \$5/);
  assert.deepEqual(Array.from(result.params), ['src_1', 'done', '2026-05-04', 'AI', 7]);
  assert.equal(result.nextParamIndex, 6);
});

test('article filters validate score, status, and date', () => {
  const { buildArticleListFilters } = loadTsModule('../src/lib/articleFilters.ts');

  assert.throws(() => buildArticleListFilters({ status: 'bad' }), /Invalid status/);
  assert.throws(() => buildArticleListFilters({ date: '04-05-2026' }), /date must be YYYY-MM-DD/);
  assert.throws(() => buildArticleListFilters({ minScore: '11' }), /minScore must be between 1 and 10/);
  assert.throws(() => buildArticleListFilters({ feedTab: 'bad' }), /Invalid feedTab/);
  assert.throws(() => buildArticleListFilters({ sort: 'bad' }), /Invalid sort/);
  assert.throws(() => buildArticleListFilters({ qualityIssue: 'bad' }), /Invalid qualityIssue/);
});

test('article filters add feed tab predicates before pagination', () => {
  const { buildArticleListFilters } = loadTsModule('../src/lib/articleFilters.ts');

  assert.match(buildArticleListFilters({ feedTab: 'news' }).where, /NOT \(s\.name ILIKE '%reddit%'/);
  assert.match(buildArticleListFilters({ feedTab: 'reddit' }).where, /reddit/);
  assert.match(buildArticleListFilters({ feedTab: 'voz' }).where, /voz/);
});

test('article search filters combine query, date, source, and feed tab predicates', () => {
  const { buildArticleSearchFilters } = loadTsModule('../src/lib/articleFilters.ts');

  assert.equal(typeof buildArticleSearchFilters, 'function');
  const result = buildArticleSearchFilters({
    query: 'gemini',
    date: '2026-05-29',
    sourceId: 'src_1',
    feedTab: 'tech',
  });

  assert.match(result.where, /a\.summary_status = 'done'/);
  assert.match(result.where, /a\.title ILIKE \$1/);
  assert.match(result.where, /DATE\(COALESCE\(a\.published_at, a\.created_at\)/);
  assert.match(result.where, /a\.source_id = \$3/);
  assert.match(result.where, /COALESCE\(s\.feed_category, 'news'\) = 'tech'/);
  assert.deepEqual(Array.from(result.params), ['%gemini%', '2026-05-29', 'src_1']);
  assert.equal(result.nextParamIndex, 4);
});

test('article search filters validate date and feed tab', () => {
  const { buildArticleSearchFilters } = loadTsModule('../src/lib/articleFilters.ts');

  assert.throws(() => buildArticleSearchFilters({ query: 'ai', date: '29-05-2026' }), /date must be YYYY-MM-DD/);
  assert.throws(() => buildArticleSearchFilters({ query: 'ai', feedTab: 'digest' }), /Invalid feedTab/);
});

test('article filters expose latest and hot ordering modes', () => {
  const { buildArticleListFilters, buildArticleListOrderBy } = loadTsModule('../src/lib/articleFilters.ts');

  assert.equal(buildArticleListFilters({}).sort, 'latest');
  assert.equal(buildArticleListFilters({ sort: 'hot' }).sort, 'hot');
  assert.match(buildArticleListOrderBy('latest'), /published_at/);
  assert.match(buildArticleListOrderBy('hot'), /hot_score/);
  assert.match(buildArticleListOrderBy('hot'), /published_at/);
});

test('article filters add quality issue predicates for admin review', () => {
  const { buildArticleListFilters } = loadTsModule('../src/lib/articleFilters.ts');

  assert.match(buildArticleListFilters({ qualityIssue: 'missing_tldr' }).where, /btrim\(a\.tldr\) = ''/);
  assert.match(buildArticleListFilters({ qualityIssue: 'missing_summary_short' }).where, /btrim\(a\.summary_short\) = ''/);
  assert.match(buildArticleListFilters({ qualityIssue: 'missing_tags' }).where, /cardinality\(a\.tags\) = 0/);
  assert.match(buildArticleListFilters({ qualityIssue: 'missing_hot_score' }).where, /a\.hot_score IS NULL/);
  assert.match(buildArticleListFilters({ qualityIssue: 'short_summary' }).where, /length\(btrim\(COALESCE\(a\.summary_text, ''\)\)\) < 200/);
  assert.match(buildArticleListFilters({ qualityIssue: 'short_summary' }).where, /a\.summary_status = 'done'/);
});

test('article local date text SQL serializes as YYYY-MM-DD instead of a UTC Date object', () => {
  const { LOCAL_DATE_TEXT_SQL } = loadTsModule('../src/lib/articleFilters.ts');

  assert.match(LOCAL_DATE_TEXT_SQL, /^TO_CHAR\(/);
  assert.match(LOCAL_DATE_TEXT_SQL, /'YYYY-MM-DD'/);
  assert.match(LOCAL_DATE_TEXT_SQL, /Asia\/Ho_Chi_Minh/);
});

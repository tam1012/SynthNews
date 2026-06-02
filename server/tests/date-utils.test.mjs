import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadTsModule(relativePath) {
  const source = readFileSync(resolve(__dirname, relativePath), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const moduleContext = { exports: {} };
  vm.runInNewContext(outputText, {
    exports: moduleContext.exports,
    module: moduleContext,
    require: () => { throw new Error('no requires expected'); },
    URL,
  });
  return moduleContext.exports;
}

const { normalizeDate, getDefaultTimezoneForLanguage } = loadTsModule('../src/lib/dateUtils.ts');

test('getDefaultTimezoneForLanguage returns +07:00 for Vietnamese', () => {
  assert.equal(getDefaultTimezoneForLanguage('vi'), '+07:00');
  assert.equal(getDefaultTimezoneForLanguage('VI'), '+07:00');
});

test('getDefaultTimezoneForLanguage returns Z for English/unknown', () => {
  assert.equal(getDefaultTimezoneForLanguage('en'), 'Z');
  assert.equal(getDefaultTimezoneForLanguage(null), 'Z');
  assert.equal(getDefaultTimezoneForLanguage(undefined), 'Z');
  assert.equal(getDefaultTimezoneForLanguage(''), 'Z');
});

test('normalizeDate respects explicit timezone in input', () => {
  // Input already has tz info → should not be remapped
  assert.equal(
    normalizeDate('2026-05-20T15:30:00+07:00'),
    '2026-05-20T08:30:00.000Z'
  );
  assert.equal(
    normalizeDate('2026-05-20T15:30:00Z'),
    '2026-05-20T15:30:00.000Z'
  );
});

test('normalizeDate with default UTC fallback for naive ISO datetime', () => {
  // Naive datetime → UTC (legacy behavior)
  assert.equal(
    normalizeDate('2026-05-20T15:30:00'),
    '2026-05-20T15:30:00.000Z'
  );
});

test('normalizeDate with Vietnam timezone fallback for naive ISO datetime', () => {
  // 15:30 in Vietnam = 08:30 UTC
  assert.equal(
    normalizeDate('2026-05-20T15:30:00', { defaultTimezone: '+07:00' }),
    '2026-05-20T08:30:00.000Z'
  );
});

test('normalizeDate handles space-separated CMS datetime', () => {
  assert.equal(
    normalizeDate('2026-05-20 15:30:00', { defaultTimezone: '+07:00' }),
    '2026-05-20T08:30:00.000Z'
  );
});

test('normalizeDate handles date-only with timezone fallback', () => {
  // Midnight Vietnam = 17:00 UTC the previous day
  assert.equal(
    normalizeDate('2026-05-20', { defaultTimezone: '+07:00' }),
    '2026-05-19T17:00:00.000Z'
  );
});

test('normalizeDate handles RFC822-style pubDate (RSS standard)', () => {
  // Already has explicit tz, fallback ignored
  assert.equal(
    normalizeDate('Thu, 07 May 2026 09:30:00 GMT'),
    '2026-05-07T09:30:00.000Z'
  );
});

test('normalizeDate returns null for empty/invalid input', () => {
  assert.equal(normalizeDate(null), null);
  assert.equal(normalizeDate(undefined), null);
  assert.equal(normalizeDate(''), null);
  assert.equal(normalizeDate('   '), null);
  assert.equal(normalizeDate('not a date'), null);
});

test('normalizeDate handles ISO datetime with milliseconds', () => {
  assert.equal(
    normalizeDate('2026-05-20T15:30:00.123', { defaultTimezone: '+07:00' }),
    '2026-05-20T08:30:00.123Z'
  );
});

test('normalizeDate rejects out-of-range years that Postgres timestamptz refuses', () => {
  // A mis-learned selector once grabbed "Published On 1 Jun 20261 Jun 2026",
  // which new Date() parses as year 20261 → "+020261-..." → Postgres throws
  // "time zone displacement out of range". Guard drops these to null.
  assert.equal(normalizeDate('1 Jun 20261 Jun 2026'), null);
  assert.equal(normalizeDate('20261-06-01'), null);
  assert.equal(normalizeDate('0005-01-01'), null);
});

test('normalizeDate accepts years within the plausible window', () => {
  assert.equal(normalizeDate('2000-01-01T00:00:00Z'), '2000-01-01T00:00:00.000Z');
  // next year is still valid (timezone skew, pre-published embargoes)
  const nextYear = new Date().getUTCFullYear() + 1;
  assert.equal(
    normalizeDate(`${nextYear}-01-01T00:00:00Z`),
    `${nextYear}-01-01T00:00:00.000Z`
  );
});

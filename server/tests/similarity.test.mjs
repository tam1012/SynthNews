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

const sim = loadTsModule('../src/lib/similarity.ts');

test('charBigrams handles latin script', () => {
  const bigrams = sim.charBigrams('hello world');
  assert.ok(bigrams.has('he'));
  assert.ok(bigrams.has('ll'));
  assert.ok(bigrams.has('wo'));
  // bigrams should not span the space between tokens
  assert.ok(!bigrams.has('o '));
  assert.ok(!bigrams.has(' w'));
});

test('charBigrams handles CJK script', () => {
  const bigrams = sim.charBigrams('銀座 異臭騒ぎ');
  assert.ok(bigrams.has('銀座'));
  assert.ok(bigrams.has('異臭'));
});

test('jaccard returns 0 when either set empty', () => {
  assert.equal(sim.jaccard(new Set(), new Set(['ab'])), 0);
  assert.equal(sim.jaccard(new Set(['ab']), new Set()), 0);
});

test('jaccard returns 1 for identical sets', () => {
  const a = sim.charBigrams('Ginza Tokyo mall attack');
  const b = sim.charBigrams('Ginza Tokyo mall attack');
  assert.equal(sim.jaccard(a, b), 1);
});

test('computeSimilarity flags near-duplicate Vietnamese titles', () => {
  // Two real-world style near-duplicate Vietnamese titles about the same Ginza incident
  const a = {
    id: 'a',
    title: 'Vụ xịt chất lạ tại trung tâm thương mại cao cấp Ginza 6 ở Tokyo khiến 20 người bị thương',
    excerpt: 'Một người đàn ông đã xịt chất lạ tại khu vực ATM thuộc trung tâm thương mại Ginza 6.',
    imageUrl: null,
  };
  const b = {
    id: 'b',
    title: 'Tokyo: 20 người bị thương sau khi bị xịt chất lạ tại Ginza',
    excerpt: 'Vụ việc xảy ra tại trung tâm thương mại Ginza ở Tokyo, khiến nhiều người phải nhập viện.',
    imageUrl: null,
  };
  const result = sim.computeSimilarity(a, b);
  assert.ok(result.score >= sim.SIMILARITY_THRESHOLD,
    `Expected score >= ${sim.SIMILARITY_THRESHOLD}, got ${result.score.toFixed(3)}`);
});

test('computeSimilarity does NOT flag unrelated articles', () => {
  const a = {
    id: 'a',
    title: 'Vụ xịt chất lạ tại Ginza Tokyo khiến 20 người bị thương',
    excerpt: 'Sự cố tại trung tâm thương mại Ginza, Tokyo.',
    imageUrl: null,
  };
  const b = {
    id: 'b',
    title: 'Apple công bố iPhone 17 với chip M5 và camera 48MP',
    excerpt: 'Apple ra mắt iPhone 17 tại sự kiện thường niên ở California.',
    imageUrl: null,
  };
  const result = sim.computeSimilarity(a, b);
  assert.ok(result.score < 0.4,
    `Expected unrelated score < 0.4, got ${result.score.toFixed(3)}`);
});

test('computeSimilarity adds image bonus when image_url matches', () => {
  const baseA = { id: 'a', title: 'Some news', excerpt: 'Foo bar baz', imageUrl: null };
  const baseB = { id: 'b', title: 'Some news', excerpt: 'Foo bar baz', imageUrl: null };
  const noImage = sim.computeSimilarity(baseA, baseB);

  const sharedImage = sim.computeSimilarity(
    { ...baseA, imageUrl: 'https://cdn.example/photo.jpg' },
    { ...baseB, imageUrl: 'https://cdn.example/photo.jpg' }
  );
  assert.ok(sharedImage.score >= noImage.score,
    'Shared image should never decrease score');
  assert.ok(sharedImage.imageMatch === true);
});

test('computeNovelty: identical content has 0 novelty', () => {
  const text = 'Ginza Tokyo attack 20 victims hospitalized police';
  assert.equal(sim.computeNovelty(text, text), 0);
});

test('computeNovelty: brand new content has high novelty', () => {
  const leader = 'Ginza Tokyo attack 20 victims hospitalized police investigation';
  const candidate = 'Police identified suspect Yamada arrested motive revenge financial';
  const novelty = sim.computeNovelty(candidate, leader);
  assert.ok(novelty >= sim.NOVELTY_THRESHOLD,
    `Expected novelty >= ${sim.NOVELTY_THRESHOLD}, got ${novelty.toFixed(3)}`);
});

test('computeNovelty: minor rewording has low novelty', () => {
  const leader = 'Ginza Tokyo attack twenty people hospitalized following spray incident store';
  const candidate = 'Twenty people hospitalized Ginza Tokyo following spray attack store incident';
  const novelty = sim.computeNovelty(candidate, leader);
  assert.ok(novelty < sim.NOVELTY_THRESHOLD,
    `Expected novelty < ${sim.NOVELTY_THRESHOLD}, got ${novelty.toFixed(3)}`);
});

test('buildClusterSignature returns a non-empty short signature', () => {
  const sig = sim.buildClusterSignature(
    'Ginza Tokyo attack',
    'Twenty people hospitalized after spray incident at Ginza Tokyo'
  );
  assert.ok(sig.length > 0);
  assert.ok(sig.split('|').length <= 5);
});

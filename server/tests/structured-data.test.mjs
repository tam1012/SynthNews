import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractStructuredArticle } from '../dist/services/fetchers/structured-data.js';

test('extracts articleBody from JSON-LD NewsArticle', () => {
  const html = `<html><head>
    <script type="application/ld+json">${JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'NewsArticle',
      headline: 'Test Headline',
      datePublished: '2026-06-04T10:00:00Z',
      image: { url: 'https://example.com/img.jpg' },
      articleBody: 'First paragraph of the story. '.repeat(40),
    })}</script>
  </head><body><article>short visible teaser</article></body></html>`;

  const result = extractStructuredArticle(html);
  assert.ok(result, 'should find a structured article');
  assert.equal(result.title, 'Test Headline');
  assert.equal(result.datePublished, '2026-06-04T10:00:00Z');
  assert.equal(result.imageUrl, 'https://example.com/img.jpg');
  assert.ok(result.articleBody.length > 500, 'body should be the full article');
  assert.ok(result.articleBody.startsWith('First paragraph'));
});

test('handles JSON-LD @graph wrapper and picks the article node', () => {
  const html = `<script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'WebPage', name: 'Page' },
      { '@type': 'Article', headline: 'Graph Article', articleBody: 'Body text here. '.repeat(50) },
    ],
  })}</script>`;

  const result = extractStructuredArticle(html);
  assert.ok(result);
  assert.equal(result.title, 'Graph Article');
  assert.ok(result.articleBody.includes('Body text here'));
});

test('normalizes an array-of-paragraphs articleBody', () => {
  const html = `<script type="application/ld+json">${JSON.stringify({
    '@type': 'Article',
    articleBody: ['Para one is reasonably long here.', 'Para two is also reasonably long here.'],
  })}</script>`;

  const result = extractStructuredArticle(html);
  assert.ok(result);
  assert.ok(result.articleBody.includes('Para one'));
  assert.ok(result.articleBody.includes('Para two'));
});

test('strips HTML tags when articleBody is markup', () => {
  const html = `<script type="application/ld+json">${JSON.stringify({
    '@type': 'Article',
    articleBody: '<p>Hello <b>world</b> this is the body.</p><p>Second line of the body.</p>',
  })}</script>`;

  const result = extractStructuredArticle(html);
  assert.ok(result);
  assert.ok(!result.articleBody.includes('<'), 'tags should be stripped');
  assert.ok(result.articleBody.includes('Hello world'));
});

test('falls back to __NEXT_DATA__ articleBody when no JSON-LD body', () => {
  const nextData = {
    props: { pageProps: { article: { articleBody: 'Embedded next data article body. '.repeat(30) } } },
  };
  const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(nextData)}</script>`;

  const result = extractStructuredArticle(html);
  assert.ok(result, 'should recover body from __NEXT_DATA__');
  assert.ok(result.articleBody.includes('Embedded next data'));
});

test('returns null when there is no structured article data', () => {
  const html = '<html><body><article>Just some visible text with no structured data.</article></body></html>';
  assert.equal(extractStructuredArticle(html), null);
});

test('ignores generic "body" AST keys to avoid tag-name pollution', () => {
  // Condé Nast-style rich-text AST: a "body" key holds typed nodes (div/p/span)
  // that must NOT be flattened into text. Only canonical articleBody/bodyText win.
  const blob = {
    props: { pageProps: { body: [{ type: 'div', children: [{ type: 'p', text: 'x' }] }] } },
  };
  const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(blob)}</script>`;
  assert.equal(extractStructuredArticle(html), null);
});

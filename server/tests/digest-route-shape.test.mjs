import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

test('digests route exposes search before digest id lookup', () => {
  const source = readFileSync(resolve(__dirname, '../src/routes/digests.ts'), 'utf8');
  const searchIndex = source.indexOf("digests.get('/search'");
  const idIndex = source.indexOf("digests.get('/:id'");

  assert.notEqual(searchIndex, -1);
  assert.notEqual(idIndex, -1);
  assert.ok(searchIndex < idIndex);
  assert.match(source, /body_markdown ILIKE/);
  assert.match(source, /digest_date/);
});

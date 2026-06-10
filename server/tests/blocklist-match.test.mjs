import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadBlocklist(rows) {
  const source = readFileSync(resolve(__dirname, '../src/services/fetchers/blocklist.ts'), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const moduleContext = { exports: {} };
  vm.runInNewContext(outputText, {
    exports: moduleContext.exports,
    module: moduleContext,
    URL,
    process: { env: {} },
    console: { warn() {} },
    Date,
    require: (name) => {
      if (name === '../../db/index.js') {
        return { getMany: async () => rows, query: async () => ({ rowCount: 1 }) };
      }
      throw new Error(`Unexpected require ${name}`);
    },
  });
  return moduleContext.exports;
}

test('wildcard path pattern matches any date segment but not other CNN videos', async () => {
  const { getBlocklistMatch } = loadBlocklist([
    { id: 'blk_1', pattern: 'edition.cnn.com/*/weather/video/', type: 'path', reason: null, is_enabled: true },
  ]);

  const blocked = await getBlocklistMatch('https://edition.cnn.com/2026/06/09/weather/video/propane-tank-floats');
  assert.ok(blocked, 'weather video with date should be blocked');
  assert.equal(blocked.pattern, 'edition.cnn.com/*/weather/video/');

  assert.ok(
    await getBlocklistMatch('https://edition.cnn.com/2026/06/08/weather/video/woman-rushes'),
    'a different date should still match the wildcard'
  );

  assert.equal(
    await getBlocklistMatch('https://edition.cnn.com/2026/06/09/world/video/real-clip'),
    null,
    'non-weather CNN videos must stay fetchable'
  );
  assert.equal(
    await getBlocklistMatch('https://edition.cnn.com/2026/06/09/politics/biden-speech'),
    null,
    'normal CNN articles must stay fetchable'
  );
});

test('plain (non-wildcard) path pattern keeps substring matching', async () => {
  const { getBlocklistMatch } = loadBlocklist([
    { id: 'blk_2', pattern: 'bbc.com/sport/', type: 'path', reason: null, is_enabled: true },
  ]);

  assert.ok(await getBlocklistMatch('https://www.bbc.com/sport/football/articles/abc'));
  assert.equal(await getBlocklistMatch('https://www.bbc.com/news/world-123'), null);
});

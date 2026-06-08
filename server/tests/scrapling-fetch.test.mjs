import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadScraplingFetch(env, fetchImpl) {
  const source = readFileSync(resolve(__dirname, '../src/services/fetchers/scrapling-fetch.ts'), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const moduleContext = { exports: {} };
  vm.runInNewContext(outputText, {
    AbortSignal,
    URL,
    console,
    fetch: fetchImpl,
    process: { env },
    exports: moduleContext.exports,
    module: moduleContext,
    require: (name) => {
      if (name === './http-utils.js') {
        return { playwrightFetch: async () => '<html></html>' };
      }
      throw new Error(`Unexpected require ${name}`);
    },
  });
  return moduleContext.exports;
}

test('scraplingFetch fails clearly in production when sidecar token is missing', async () => {
  const { scraplingFetch } = loadScraplingFetch(
    { NODE_ENV: 'production', SCRAPLING_SERVICE_URL: 'http://scrapling:8000' },
    async () => {
      throw new Error('fetch should not be called');
    },
  );

  await assert.rejects(
    () => scraplingFetch('https://example.com/article'),
    /SCRAPLING_SERVICE_TOKEN not configured/,
  );
});

test('scraplingFetch sends X-Sidecar-Token when configured', async () => {
  let capturedUrl = '';
  let capturedInit = {};
  const { scraplingFetch } = loadScraplingFetch(
    {
      NODE_ENV: 'production',
      SCRAPLING_SERVICE_URL: 'http://scrapling:8000',
      SCRAPLING_SERVICE_TOKEN: 'sidecar-secret',
    },
    async (url, init) => {
      capturedUrl = url;
      capturedInit = init;
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, html: '<html>ok</html>', status_code: 200, elapsed_ms: 5 }),
      };
    },
  );

  const html = await scraplingFetch('https://example.com/article', { mode: 'fast', timeoutMs: 1000 });

  assert.equal(html, '<html>ok</html>');
  assert.equal(capturedUrl, 'http://scrapling:8000/fetch');
  assert.equal(capturedInit.method, 'POST');
  assert.equal(capturedInit.headers['X-Sidecar-Token'], 'sidecar-secret');
  assert.equal(capturedInit.headers['Content-Type'], 'application/json');
});

test('scraplingFetch forwards cookie header to sidecar options without logging it', async () => {
  let capturedBody = {};
  const { scraplingFetch } = loadScraplingFetch(
    {
      NODE_ENV: 'production',
      SCRAPLING_SERVICE_URL: 'http://scrapling:8000',
      SCRAPLING_SERVICE_TOKEN: 'sidecar-secret',
    },
    async (_url, init) => {
      capturedBody = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, html: '<html>ok</html>', status_code: 200, elapsed_ms: 5 }),
      };
    },
  );

  await scraplingFetch('https://www.reuters.com/world/example', {
    mode: 'stealth',
    timeoutMs: 1000,
    cookieHeader: 'datadome=test-cookie',
  });

  assert.equal(capturedBody.options.cookie_header, 'datadome=test-cookie');
});

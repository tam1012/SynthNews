import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadHttpUtils({ normalizeWithDns, fetchImpl }) {
  const source = readFileSync(resolve(__dirname, '../src/services/fetchers/http-utils.ts'), 'utf8');
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
    Math,
    process: {
      env: {
        WORKER_PROXY_URL: 'https://proxy.example',
        WORKER_PROXY_TOKEN: 'proxy-token',
      },
    },
    exports: moduleContext.exports,
    module: moduleContext,
    require: (name) => {
      if (name === 'undici') return { ProxyAgent: class ProxyAgent {}, fetch: fetchImpl };
      if (name === 'child_process') return { execFile: () => { throw new Error('curl should not run'); } };
      if (name === 'playwright') return { chromium: { launch: async () => { throw new Error('browser should not launch'); } } };
      if (name === 'puppeteer-core') return { default: { launch: async () => { throw new Error('browser should not launch'); } } };
      if (name === '../../lib/utils.js') {
        return {
          normalizePublicHttpUrl: (value) => new URL(value).toString(),
          normalizePublicHttpUrlWithDns: normalizeWithDns,
        };
      }
      throw new Error(`Unexpected require ${name}`);
    },
  });
  return moduleContext.exports;
}

test('workerProxyFetch rejects targets that fail DNS-safe URL validation before calling fetch', async () => {
  let fetchCalls = 0;
  const { workerProxyFetch } = loadHttpUtils({
    normalizeWithDns: async () => null,
    fetchImpl: async () => {
      fetchCalls++;
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => 'ok' };
    },
  });

  await assert.rejects(
    () => workerProxyFetch('https://evil.example/private'),
    /public http\(s\) URL/,
  );
  assert.equal(fetchCalls, 0);
});

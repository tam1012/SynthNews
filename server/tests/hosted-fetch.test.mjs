import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load hosted-fetch.ts in an isolated VM with a stub fetch so we can assert which
// provider endpoints get called, in what order, for normal vs DataDome hosts.
function loadHostedFetch(env, fetchImpl) {
  const usageCounters = {};
  const source = readFileSync(resolve(__dirname, '../src/services/fetchers/hosted-fetch.ts'), 'utf8');
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
      if (name === './hosted-fetch-usage.js') return {
        reserveHostedFetchAttempt: async (provider, cap) => {
          usageCounters[provider] = (usageCounters[provider] || 0) + 1;
          return { allowed: usageCounters[provider] <= cap, usedCount: usageCounters[provider] };
        },
      };
      throw new Error(`Unexpected require ${name}`);
    },
  });
  return moduleContext.exports;
}

const FULL_ENV = {
  SCRAPINGANT_API_KEY: 'sa-key',
  SCRAPEDO_API_KEY: 'sd-key',
  FIRECRAWL_API_KEY: 'fc-key',
};

// A long HTML body that passes looksBlockedOrEmpty (>= 500 chars, no challenge markers).
const GOOD_HTML = '<html><body>' + 'x'.repeat(600) + '</body></html>';

function classify(url) {
  if (url.includes('api.scrapingant.com') && url.includes('proxy_type=residential')) return 'scrapingant-residential';
  if (url.includes('api.scrapingant.com')) return 'scrapingant-datacenter';
  if (url.includes('api.scrape.do')) return 'scrapedo';
  if (url.includes('api.geekflare.com')) return 'geekflare';
  if (url.includes('api.firecrawl.dev')) return 'firecrawl';
  return 'unknown';
}

test('normal host: ScrapingAnt datacenter is tried first and wins', async () => {
  const calls = [];
  const { hostedFetch } = loadHostedFetch(FULL_ENV, async (url) => {
    calls.push(classify(url));
    return { ok: true, status: 200, text: async () => GOOD_HTML };
  });

  const { provider } = await hostedFetch('https://example.com/article', 1000);
  assert.equal(provider, 'scrapingant');
  assert.deepEqual(calls, ['scrapingant-datacenter']);
});

test('DataDome host (Reuters): datacenter is skipped, Scrape.do leads, residential never reached when Scrape.do wins', async () => {
  const calls = [];
  const { hostedFetch } = loadHostedFetch(FULL_ENV, async (url) => {
    calls.push(classify(url));
    return { ok: true, status: 200, text: async () => GOOD_HTML };
  });

  const { provider } = await hostedFetch('https://www.reuters.com/world/india/story-2026-06-04', 1000);
  assert.equal(provider, 'scrapedo');
  // datacenter ScrapingAnt must not appear; residential not needed because Scrape.do succeeded
  assert.deepEqual(calls, ['scrapedo']);
});

test('DataDome host: falls through Scrape.do -> Firecrawl -> ScrapingAnt residential', async () => {
  const calls = [];
  const { hostedFetch } = loadHostedFetch(FULL_ENV, async (url) => {
    const who = classify(url);
    calls.push(who);
    if (who === 'scrapedo') return { ok: false, status: 500, text: async () => '' };
    if (who === 'firecrawl') {
      return { ok: true, status: 200, json: async () => ({ success: false, error: 'datadome' }) };
    }
    // residential succeeds
    return { ok: true, status: 200, text: async () => GOOD_HTML };
  });

  const { provider } = await hostedFetch('https://www.reuters.com/world/x-2026-06-04', 1000);
  assert.equal(provider, 'scrapingant-residential');
  assert.deepEqual(calls, ['scrapedo', 'firecrawl', 'scrapingant-residential']);
});

test('residential is honored as a custom DATADOME_DOMAINS entry', async () => {
  const calls = [];
  const { hostedFetch } = loadHostedFetch(
    { ...FULL_ENV, DATADOME_DOMAINS: 'bloomberg.com' },
    async (url) => {
      calls.push(classify(url));
      return { ok: true, status: 200, text: async () => GOOD_HTML };
    },
  );

  // bloomberg.com is in the override -> uses DataDome chain (Scrape.do first)
  const bb = await hostedFetch('https://www.bloomberg.com/news/x', 1000);
  assert.equal(bb.provider, 'scrapedo');
  // reuters.com is NOT in the override -> normal chain (datacenter first)
  calls.length = 0;
  const rt = await hostedFetch('https://www.reuters.com/world/y', 1000);
  assert.equal(rt.provider, 'scrapingant');
  assert.deepEqual(calls, ['scrapingant-datacenter']);
});

test('residential daily cap is enforced independently of datacenter', async () => {
  const calls = [];
  const { hostedFetch } = loadHostedFetch(
    { ...FULL_ENV, SCRAPINGANT_RESIDENTIAL_MAX_PER_DAY: '1' },
    async (url) => {
      const who = classify(url);
      calls.push(who);
      // Scrape.do + Firecrawl always fail so the chain reaches residential
      if (who === 'scrapedo') return { ok: false, status: 500, text: async () => '' };
      if (who === 'firecrawl') return { ok: true, status: 200, json: async () => ({ success: false, error: 'blocked' }) };
      return { ok: true, status: 200, text: async () => GOOD_HTML };
    },
  );

  // First Reuters fetch uses residential (1/1)
  const first = await hostedFetch('https://www.reuters.com/a', 1000);
  assert.equal(first.provider, 'scrapingant-residential');

  // Second Reuters fetch: residential cap reached -> all providers fail
  calls.length = 0;
  await assert.rejects(
    () => hostedFetch('https://www.reuters.com/b', 1000),
    /residential: daily cap reached/,
  );
  // residential endpoint must not be hit the second time
  assert.equal(calls.includes('scrapingant-residential'), false);
});

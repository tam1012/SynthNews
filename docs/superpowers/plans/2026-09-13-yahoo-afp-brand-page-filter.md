# Yahoo AFP Brand-Page Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep AFP story discovery active while preventing Yahoo publication profile pages from consuming fetch and AI-summary resources.

**Architecture:** Reuse the HTML fetcher's existing `shouldSkipWebArticleUrl` boundary. Classify `profiles.yahoo.com/brands/*` as non-article URLs, filter all combined discovery results through it, and retain the existing fetch-time guard for stale jobs.

**Tech Stack:** Node.js, TypeScript, Hono backend, Cheerio, Node test runner

---

### Task 1: Add failing Yahoo AFP regression coverage

**Files:**
- Modify: `server/tests/html-fetcher.test.mjs`
- Test: `server/tests/html-fetcher.test.mjs`

- [ ] **Step 1: Write the discovery regression test**

Add a test whose HTML contains a real AFP story on `www.yahoo.com` and whose
sitemap stub returns an unrelated `profiles.yahoo.com/brands/first-for-money`
landing page. Assert that only the real story is returned:

```js
test('HTML discover drops Yahoo brand profiles while keeping AFP story links', async () => {
  const { htmlFetcher } = loadTsModule('../src/services/fetchers/html-fetcher.ts', {
    ...baseStubs,
    './sitemap-discovery.js': {
      discoverSitemapArticles: async () => [{
        sourceId: 'src_afp',
        url: 'https://profiles.yahoo.com/brands/first-for-money',
        title: 'first for money',
        externalId: 'https://profiles.yahoo.com/brands/first-for-money',
        publishedAt: null,
        payload: { discovery: 'sitemap', sitemapUrl: 'https://profiles.yahoo.com/sitemap.xml' },
      }],
    },
  }, {
    fetch: async () => ({
      ok: true,
      text: async () => '<a href="https://www.yahoo.com/news/world/articles/real-afp-story-with-long-slug-123456789.html">Real AFP world news story with a sufficiently long title</a>',
    }),
  });

  const items = await htmlFetcher.discover({
    id: 'src_afp',
    type: 'web',
    name: 'AFP @ Yahoo',
    url: 'https://profiles.yahoo.com/brands/afp/',
    language: 'en',
    category: null,
    fetch_interval_minutes: 60,
    parser_config: { discoverSitemap: true },
  });

  assert.deepEqual(items.map((item) => item.url), [
    'https://www.yahoo.com/news/world/articles/real-afp-story-with-long-slug-123456789.html',
  ]);
});
```

- [ ] **Step 2: Write the stale-job regression test**

Add a test that calls `fetchArticle` with a queued Yahoo brand profile and a
network stub that throws if invoked. Assert that the result is `null`:

```js
test('HTML fetchArticle skips queued Yahoo brand profile pages before network fetch', async () => {
  let networkCalled = false;
  const { htmlFetcher } = loadTsModule('../src/services/fetchers/html-fetcher.ts', baseStubs, {
    fetch: async () => {
      networkCalled = true;
      throw new Error('network fetch should not run');
    },
  });

  const result = await htmlFetcher.fetchArticle({
    id: 'job_brand',
    source_id: 'src_afp',
    url: 'https://profiles.yahoo.com/brands/first-for-sports',
    title: 'First for Sports',
    external_id: null,
    published_at: null,
    payload_json: null,
  }, {
    id: 'src_afp',
    type: 'web',
    name: 'AFP @ Yahoo',
    url: 'https://profiles.yahoo.com/brands/afp/',
    language: 'en',
    category: null,
    fetch_interval_minutes: 60,
    parser_config: { discoverSitemap: true },
  });

  assert.equal(result, null);
  assert.equal(networkCalled, false);
});
```

- [ ] **Step 3: Run the focused tests and verify RED**

Run:

```powershell
node --test --test-name-pattern="Yahoo brand" tests/html-fetcher.test.mjs
```

Expected: both new tests fail because Yahoo brand profile URLs are not yet
classified as non-article URLs.

### Task 2: Add the minimal URL guard

**Files:**
- Modify: `server/src/services/fetchers/html-fetcher.ts:72-93`
- Modify: `server/src/services/fetchers/html-fetcher.ts:331-339`
- Test: `server/tests/html-fetcher.test.mjs`

- [ ] **Step 1: Classify Yahoo publication profiles as non-articles**

Add this condition inside `shouldSkipWebArticleUrl`, after `host` and `path` are
computed:

```ts
if (host === 'profiles.yahoo.com' && /^\/brands(?:\/|$)/.test(path)) {
  return true;
}
```

- [ ] **Step 2: Apply the guard to combined discovery output**

Filter the combined heuristic, selector, and sitemap results before limiting:

```ts
return dedupeDiscovered(discovered)
  .filter((item) => !shouldSkipWebArticleUrl(item.url))
  .slice(0, parsePositiveInt(process.env.MAX_ARTICLES_PER_SOURCE, 20));
```

- [ ] **Step 3: Run the focused tests and verify GREEN**

Run:

```powershell
node --test --test-name-pattern="Yahoo brand" tests/html-fetcher.test.mjs
```

Expected: both Yahoo brand tests pass.

- [ ] **Step 4: Run the full server suite and static checks**

Run:

```powershell
npm test
npm run build
git diff --check
```

Expected: all server tests pass, TypeScript build exits 0, and `git diff --check`
prints no errors.

- [ ] **Step 5: Commit the implementation**

```powershell
git add -- server/src/services/fetchers/html-fetcher.ts server/tests/html-fetcher.test.mjs docs/superpowers/plans/2026-09-13-yahoo-afp-brand-page-filter.md
git commit -m "fix(fetch): skip Yahoo brand landing pages"
```

### Task 3: Deploy, verify, and hide known false articles

**Files:**
- No repository files modified

- [ ] **Step 1: Push main and wait for GitHub Actions**

Run:

```powershell
git push origin main
gh run watch --exit-status
```

Expected: the deploy workflow completes successfully.

- [ ] **Step 2: Verify production source and runtime state**

Query the VPS and confirm that `AFP @ Yahoo` still has `is_enabled=true`, the app
container is healthy, and the deployed commit matches local `HEAD`.

- [ ] **Step 3: Hide the two known false articles and their completed jobs**

In a transaction, update articles
`art_CcNUHgdl4-0R_Grf` and `art_rviWEZBziDkv4Pew` from `done` to `skipped`, and
set matching `profiles.yahoo.com/brands/*` fetch jobs to `skipped` with an
explicit `skip_reason`. Do not delete data and do not modify the AFP source.

- [ ] **Step 4: Run a production AFP discovery verification**

Trigger or observe one AFP scrape cycle, then verify:

- real Yahoo-hosted AFP article jobs continue to be discovered;
- no new `profiles.yahoo.com/brands/*` job is inserted;
- the two known false articles are absent from the public `status=done` feed;
- `AFP @ Yahoo` remains enabled.

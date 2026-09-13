# Yahoo AFP brand-page filter design

## Goal

Keep the `AFP @ Yahoo` source enabled and continue discovering AFP articles from
`https://profiles.yahoo.com/brands/afp/`, while preventing Yahoo brand landing
pages from entering the fetch and summary pipelines.

## Root cause

The AFP profile page yields real AFP story links on Yahoo article hosts through
the existing heuristic discovery path. The source also enables sitemap
discovery. Yahoo's global profile sitemap includes unrelated landing pages such
as:

- `https://profiles.yahoo.com/brands/first-for-money`
- `https://profiles.yahoo.com/brands/first-for-sports`

Those URLs are publication profile pages rather than individual news articles.
Their titles do not contain deal or promotion keywords, so the general promo
filter does not reject them. Fetching them therefore wastes browser, database,
and AI-summary capacity.

## Selected design

Extend the HTML fetcher's existing non-article URL guard so every URL whose
hostname is `profiles.yahoo.com` and whose path starts with `/brands/` is treated
as a non-article page.

Apply the same guard at two existing boundaries:

1. Before discovered HTML and sitemap candidates are returned to the queue.
2. At `fetchArticle`, where the guard already protects against stale or manually
   queued non-article jobs.

The source itself remains enabled. Discovery continues to fetch the AFP profile
page, and links to real stories on `www.yahoo.com`, `finance.yahoo.com`,
`travel.yahoo.com`, and other Yahoo article hosts remain eligible.

The source's `discoverSitemap` setting will not be changed as part of this fix.

## Tests

Add focused HTML-fetcher tests proving that:

- a sitemap candidate under `profiles.yahoo.com/brands/*` is removed;
- a real AFP story URL on a Yahoo article host remains in discovery results;
- a stale queued Yahoo brand landing page is skipped before any network fetch;
- existing CNN non-article URL behavior remains unchanged through the full test
  suite.

Follow test-driven development: add the regression test first, confirm the
expected failure, implement the smallest guard, then run the focused and full
server test suites.

## Deployment and cleanup

Commit and push the local code through the existing GitHub Actions deployment.
After production verification, mark the two known false articles as skipped so
they no longer appear in the public feed. Do not disable or delete the AFP
source.

## Success criteria

- `AFP @ Yahoo` remains enabled.
- New AFP articles on Yahoo continue to be discovered and summarized.
- No new `profiles.yahoo.com/brands/*` fetch jobs are created.
- Existing queued brand landing-page jobs are skipped without fetching.
- The two known false articles no longer appear in the public feed.

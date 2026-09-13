# Scrapling Watchdog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore a fresh SynthNews article pipeline by recycling wedged Scrapling workers, limiting residential-proxy escalation, and prioritizing recent fetch jobs.

**Architecture:** The Python sidecar schedules its own process exit only when a non-cancellable browser executor future times out, allowing Docker to reap the leaked browser tree. TypeScript keeps proactive proxy routing but gates broad block-triggered escalation, while queue SQL expires stale work before claiming newest jobs.

**Tech Stack:** Python 3.11, FastAPI, asyncio, Node.js, TypeScript, PostgreSQL, Docker Compose.

---

### Task 1: Add a process-fatal browser timeout watchdog

**Files:**
- Create: `scrapling-sidecar/tests/test_watchdog.py`
- Modify: `scrapling-sidecar/app/config.py`
- Modify: `scrapling-sidecar/app/main.py`
- Modify: `docker-compose.yml`

- [ ] Write a failing unittest that awaits an unresolved future, asserts a browser timeout, and records exactly one scheduled exit.
- [ ] Run `python -m unittest discover -s scrapling-sidecar/tests -v` and verify the missing watchdog behavior fails.
- [ ] Add `BrowserFetchTimeout`, `_await_browser_result`, and idempotent `_schedule_restart_after_timeout`; expose restart state and oldest request age from `/health` with HTTP 503 while restart is pending.
- [ ] Pass `SCRAPLING_RESTART_DELAY_MS` through Compose and default it to 250 ms.
- [ ] Re-run the Python tests and verify they pass.

### Task 2: Make residential proxy escalation opt-in

**Files:**
- Modify: `server/tests/scrapling-fetch.test.mjs`
- Modify: `server/src/services/fetchers/scrapling-fetch.ts`
- Modify: `server/src/services/fetchers/html-fetcher.ts`
- Modify: `server/src/services/fetchers/rss-fetcher.ts`
- Modify: `.env.example`
- Modify: `docker-compose.yml`

- [ ] Add failing Node tests proving broad escalation is false by default, opt-in accepts `true`, and allowlisted domains still return the configured proxy.
- [ ] Run `node --test server/tests/scrapling-fetch.test.mjs` and verify the new default test fails.
- [ ] Add `isBlockTriggeredProxyEnabled()` and replace broad caller guards; preserve proactive allowlist and explicit proxy behavior.
- [ ] Document/pass `SCRAPLING_BLOCK_TRIGGERED_PROXY_ENABLED=false`.
- [ ] Re-run the focused test and verify it passes.

### Task 3: Keep the fetch queue fresh

**Files:**
- Modify: `server/tests/article-fetch-queue.test.mjs`
- Modify: `server/src/services/article-fetch-queue.ts`
- Modify: `server/src/jobs/scheduler.ts`
- Modify: `.env.example`
- Modify: `docker-compose.yml`

- [ ] Add failing tests proving stale discovered jobs receive a stable skip reason and claim SQL orders by publish/discovery freshness descending.
- [ ] Run `node --test server/tests/article-fetch-queue.test.mjs` and verify the SQL assertions fail.
- [ ] Add `buildExpireStaleArticleFetchJobsSql`, call it before each claim, and log the number expired.
- [ ] Configure a 36-hour freshness window plus bounded per-run and timeout values in Compose.
- [ ] Re-run queue and scheduler timeout tests and verify they pass.

### Task 4: Verify, commit, deploy, and inspect production

**Files:**
- Review all modified files above.

- [ ] Run Python tests, focused Node tests, `npm run build`, and the complete server test suite; distinguish pre-existing harness failures from regressions.
- [ ] Review `git diff --check`, `git status --short`, and the staged diff for secrets/local-only files.
- [ ] Commit the focused change, merge it into local `main`, and push `origin/main`.
- [ ] Wait for the deploy workflow and verify the VPS commit and clean tracked state.
- [ ] Verify sidecar health/process age, fetch backlog movement, and fresh public article API results without exposing credentials.

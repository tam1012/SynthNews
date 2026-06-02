# SynthNews

Language: [🇺🇸 English](./README.md) | [🇻🇳 Tiếng Việt](./README_VI.md)

---

SynthNews is a high-performance, full-stack personal news aggregator and AI-powered discussion digest system. It crawls articles, discussions, and threads from RSS feeds, standard websites, Reddit, and VOZ forums, stores them in PostgreSQL, and uses Large Language Models (LLMs) to perform hybrid promotion filtering, translate foreign titles, generate structured TL;DR bullet points, and draft daily summary digests. The application serves these digests through a premium, responsive React-based reading dashboard designed for both desktop and mobile devices.

Designed for self-hosting with minimal maintenance, SynthNews features automatic cron schedules, robust anti-bot scraping bypasses, dynamic AI-learned selector caching, and zero-downtime Docker Compose deployments with full GitHub Actions integration.

---

## Table of Contents

- [Core Features](#core-features)
  - [1. Intelligent Crawling & Anti-Bot Pipeline](#1-intelligent-crawling--anti-bot-pipeline)
  - [2. AI Summarization, Translation & Digest Processing](#2-ai-summarization-translation--digest-processing)
  - [3. Premium Reading Experience](#3-premium-reading-experience)
  - [4. Admin Console & Monitoring](#4-admin-console--monitoring)
- [System Architecture](#system-architecture)
- [Technology Stack](#technology-stack)
- [Repository Structure](#repository-structure)
- [Data Flow & Scraper Pipeline](#data-flow--scraper-pipeline)
- [Database Schema & Migrations](#database-schema--migrations)
- [Environment Variables](#environment-variables)
- [Local Development Setup](#local-development-setup)
- [Testing & Quality Verification](#testing--quality-verification)
- [Production Deployment](#production-deployment)
- [Cloudflare Workers Proxies](#cloudflare-workers-proxies)
- [Operational Runbook](#operational-runbook)

---

## Core Features

### 1. Intelligent Crawling & Anti-Bot Pipeline

*   **Multi-Tier Fetching Cascade**: Overcomes datacenter IP blocks and rate limits via an automatic fallback cascade:
    $$\text{Native HTTP} \rightarrow \text{CF Worker Proxies} \rightarrow \text{Scrapling Stealth} \rightarrow \text{Scrapling + Residential Proxy} \rightarrow \text{Hosted Fetch APIs}$$
*   **Hosted Fetch Chain**: When every free tier is defeated by anti-bot challenges, requests escalate to a chain of commercial scraping APIs tried in order of free-credit abundance: **ScrapingAnt → Scrape.do → Firecrawl** (the latter being strongest against DataDome, e.g. Reuters). Each provider is skipped if it lacks a key or hits its rolling 24h cap; a 429/error/blocked response falls through to the next.
*   **Block-Triggered Escalation**: Any host that fails all free layers *because it was blocked* (HTTP 4xx or a Cloudflare/DataDome challenge page) auto-escalates to the hosted fetch chain — no allowlist edit required. Genuinely short or 404 pages do *not* escalate, preserving credits. `HOSTED_FETCH_DOMAINS` additionally forces known-hard hosts to try hosted fetch proactively.
*   **Selector-Free Web Sources**: Web sources need only a section URL (e.g. `https://www.reuters.com/world/`); the HTML fetcher auto-discovers article links via heuristic link scoring and sitemap parsing, with no hand-written `articleLinkSelector` required.
*   **AI-Learned CSS Selectors**: Utilizes LLMs to inspect raw HTML once, automatically discover the main article content and title selectors, and cache these selector profiles. If selectors break due to website updates, the engine relearns them automatically.
*   **3-Stage Content Extraction**: Extracts clean text using AI learned selectors first, falls back to static Cheerio parsing second, and uses Mozilla Readability library third.
*   **Deep Forum Crawling**:
    *   *Reddit*: Fetches threads and nested comment trees via Reddit RSS, OAuth APIs, or proxy fallbacks. Ranks comments using a scoring formula (upvotes, early comments, length, depth) to distill community sentiment.
    *   *VOZ Forum*: Interacts with forum threads, parses paginated threads (up to a configurable limit), separates Original Poster (OP) context from comments, and extracts top-voted discussions.
*   **Rate Limiting & Safety**: Includes a per-domain throttle delay (default 10s between requests to the same host) and an automated rescue job to re-queue articles that were skipped due to incomplete fetches.

### 2. AI Summarization, Translation & Digest Processing

*   **Multi-Provider AI Client**: Native support for Google Gemini, Vertex AI, OpenAI, Anthropic, DeepSeek, Groq, and Xiaomi MIMO APIs. Features an automatic fallback policy if the active provider fails.
*   **Hybrid Promotion & Spam Filtering**: Implements a zero-cost keyword filter at the discovery stage, followed by an LLM-based classifier at the summarization stage to keep advertisement and sponsored content out of the user's feed.
*   **Title Translation**: Translates foreign language titles into Vietnamese, rendering them side-by-side with original titles for bilingual context.
*   **Dynamic Digests**: Aggregates high-scoring articles and summaries processed in the last 24 hours to synthesize a readable markdown newsletter.

### 3. Premium Reading Experience

*   **Responsive Multi-Device Layout**: Desktop users get a split-view layout (list on the left, full content detail on the right) with full keyboard navigation. Mobile users benefit from a bottom navigation tab bar, auto-hiding headers, and overlay detail panels with swipe-to-close gestures.
*   **Aesthetic Performance**: Designed using custom CSS tokens (no generic styling library placeholders), featuring sleek Dark Mode (GitHub-inspired palette) and Light Mode. Font sizing sheets are fully adjustable.
*   **Open Graph Meta Injection**: Server-side injects SEO-friendly Open Graph meta headers into deep-linked routes (`/article/:id`) for native rich previews when sharing links.
*   **Optimized Client Caching**: Client-side hook `useApi` enforces an in-memory cache policy (e.g., 60 seconds for feeds, 300 seconds for source configurations) to ensure immediate page loads.

### 4. Admin Console & Monitoring

*   **Health and Scraping Logs**: View detailed scrape summaries, success rates, API error counts, and database sizes.
*   **Job Trigger Dashboard**: Manually trigger scraping, queue fetching, summarization, digest building, and database cleanup.
*   **Prompt Configuration Admin**: Read, edit, and hot-reload AI prompts used for summarization, forum digests, and newsletters directly from the UI without restart.

---

## System Architecture

```text
                                  ┌──────────────────────┐
                                  │   Nginx (Port 443)   │
                                  └──────────┬───────────┘
                                             │ reverse-proxy
                                             ▼
                               ┌────────────────────────────┐
                               │   Hono API App Container   │
                               │        (Port 3001)         │
                               └──────┬──────┬───────┬──────┘
                                      │      │       │
             ┌────────────────────────┘      │       └────────────────────────┐
             ▼ read/write                    ▼ fetch proxies                  ▼ bypass Cloudflare
   ┌───────────────────┐           ┌───────────────────┐            ┌───────────────────┐
   │ PostgreSQL 16 DB  │           │ Cloudflare Worker │            │ Scrapling Sidecar │
   │    (Port 5433)    │           │    (Serverless)   │            │   (Python App)    │
   └───────────────────┘           └───────────────────┘            └───────────────────┘
```

*   **Monorepo Workspaces**: Developed as an npm workspace split into `client/` (React SPA) and `server/` (Hono API, Scheduler, Crawler, DB runner).
*   **Docker Containerization**: Three containers managed via `docker-compose.yml`: the main Hono application server, PostgreSQL 16 database, and the Python Scrapling sidecar service.
*   **Local Caddy Integration**: Runs `synthnews.local` locally using Caddy v2 with self-signed SSL/TLS matching the production Nginx behavior.

---

## Technology Stack

### Frontend
*   **Framework**: React 19
*   **Routing**: React Router 7
*   **Bundler**: Vite 6
*   **Styling**: Pure CSS (custom variables, responsive grids, and typography in `client/src/styles/global.css`)
*   **Components**: Markdown renderer (`react-markdown`), responsive navigation layouts, customizable setting sheets.

### Backend
*   **Runtime**: Node.js 22 (Typescript)
*   **API Framework**: Hono
*   **Database Client**: `pg` (PostgreSQL)
*   **Job Scheduler**: `node-cron`
*   **AI Integration**: Multi-client router supporting Gemini SDK, OpenAI-compatible APIs, Vertex AI credentials, and Custom REST endpoints.
*   **Scraping Helpers**: Cheerio, RSS-Parser, Mozilla Readability, jsdom.

### Sidecars & Proxies
*   **Scrapling Sidecar**: Python-based stealth scraping microservice leveraging Playwright/Stealth browsers to bypass Cloudflare. Supports an optional residential proxy passthrough for hard-blocked, domain-gated hosts.
*   **Cloudflare Workers**: Edge proxies dynamically routing Reddit, VOZ, and Reuters requests.
*   **Hosted Fetch APIs**: A fallback chain of commercial scraping APIs (ScrapingAnt, Scrape.do, Firecrawl) used as the last resort against DataDome/Cloudflare, each gated by an optional key and a per-provider daily cap.

---

## Repository Structure

```text
.
├── .github/workflows/deploy.yml # GitHub Actions CI/CD configuration
├── client/                      # Frontend Vite + React SPA
│   ├── index.html
│   ├── src/
│   │   ├── components/          # Reusable UI components & layouts
│   │   ├── hooks/useApi.ts      # API fetch client & caching hook
│   │   ├── pages/               # Main layout views (Home, Admin, Sources)
│   │   ├── services/            # Cache client & service worker registration
│   │   ├── styles/global.css    # Core styling file
│   │   └── main.tsx
│   └── tests/                   # Frontend unit tests
├── server/                      # Backend Hono API & scheduler
│   ├── src/
│   │   ├── db/                  # PostgreSQL client & migration files
│   │   ├── jobs/scheduler.ts    # Cron manager and locking mutexes
│   │   ├── lib/                 # Core utility engines (OG, image proxy, auth)
│   │   ├── routes/              # Hono REST router controllers
│   │   ├── services/            # Main crawlers, queue buffers, and summarizers
│   │   └── index.ts             # Node server main entry
│   └── tests/                   # Backend tests (API & parsing tests)
├── scrapling-sidecar/           # Python scraper service
├── Dockerfile                   # Multi-stage production image builder
├── docker-compose.yml           # Multi-container local/production docker system
├── Caddyfile.local              # Local Caddy HTTPS server config
├── fetch-proxy-worker.js        # Generic proxy script for Cloudflare Workers
├── reddit-proxy-worker.js       # Dedicated Reddit CF proxy
├── voz-proxy-worker.js          # Dedicated VOZ CF proxy
└── reuters-proxy-worker.js      # Dedicated Reuters CF proxy
```

---

## Data Flow & Scraper Pipeline

### 1. Source Discovery & Scraping
The scheduler executes every 5 minutes, querying the PostgreSQL database for enabled sources that have reached their scheduled `next_run_at`. 
*   **RSS / RSS Forum Feed**: Fetches feed items and places them in `article_fetch_jobs` as raw URL payloads.
*   **Direct Web Sources**: Analyzes the site, checks cached selector profiles, and extracts raw text using the multi-tier fetching cascade.
*   **Adaptive Backoff**: Successful crawls schedule `next_run_at` based on `fetch_interval_minutes` with added jitter. Successive failures increase the delay exponentially, up to a maximum of 24 hours.

### 2. Article Fetching & Detail Enrichment
A queue worker pulls pending items from `article_fetch_jobs` using atomic database locks:
```sql
SELECT id FROM article_fetch_jobs WHERE status = 'pending' FOR UPDATE SKIP LOCKED LIMIT 10
```
It fetches full text, extracts content, filters out advertisements, and inserts records into `articles` with `summary_status = 'pending'`.

### 3. AI Processing & Summarization
Another independent worker polls the `articles` database for `pending` summaries:
1.  It checks the active AI Provider configurations.
2.  Applies appropriate system prompts based on the article's source type (standard news, tech news, Reddit thread, or forum thread).
3.  Instructs the LLM to filter promotions, translate foreign titles, write a concise summary, and extract a lists of TL;DR bullet points.
4.  Updates status to `done` on success or `failed`/`skipped` depending on errors or text length thresholds.

---

## Database Schema & Migrations

SynthNews manages its relational schema using a custom TypeScript migration engine (`server/src/db/migrate.ts`) executing standard SQL scripts. 

*   `001_initial.sql`: Core tables for `sources`, `articles`, `scrape_logs`, `digests`, and `digest_items`.
*   `002_ai_providers.sql`: Stores active credentials for OpenAI, Gemini, Vertex, etc., alongside global system preferences.
*   `003_add_tldr.sql`: Introduces the `tldr` structured bullet point column in the `articles` table.
*   `004_add_rescraped_count.sql`: Counter field used for forum thread comment updates.
*   `005_article_ai_metadata.sql`: Token metrics, AI model used, and timing data.
*   `006_article_retry_state.sql`: Tracks error counts and retry intervals.
*   `007_article_fetch_jobs.sql`: Implements the 2-phase buffer queue table.
*   `012_source_profiles.sql`: Stores CSS selectors learned by the AI for web sources.
*   `013_blocklist.sql`: Regex filter lists to discard unwanted URL/domain patterns.
*   `015_add_translated_title.sql`: Stores translations of foreign language article headlines.

---

## Environment Variables

The application reads configuration from local `.env` files. Critical parameters include:

| Environment Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection URI |
| `ADMIN_TOKEN` | Bearer token for accessing admin APIs and write operations |
| `PUBLIC_SITE_URL` | Base URL used to build Open Graph tags |
| `CORS_ORIGIN` | Allowed origin for frontend requests |
| `SCRAPE_INTERVAL_HOURS` | Delay before generating the next daily digest newsletter (default: `1`) |
| `MAX_ARTICLES_PER_SOURCE` | Maximum number of articles discovered per source during one crawl (default: `20`) |
| `MAX_AI_CALLS_PER_RUN` | Maximum number of pending articles summarized in a single cron tick (default: `30`) |
| `SCRAPLING_SERVICE_URL` | Address of the Python sidecar service (default: `http://scrapling:8000`) |
| `SCRAPLING_PROXY_URL` / `SCRAPLING_PROXY_DOMAINS` | Optional residential proxy + host allowlist routed through Scrapling for hard-blocked domains |
| `SCRAPINGANT_API_KEY` / `SCRAPEDO_API_KEY` / `FIRECRAWL_API_KEY` | Optional hosted-fetch provider keys (chain tried in that order) |
| `*_MAX_PER_DAY` | Rolling 24h request cap per hosted provider (defaults: ScrapingAnt `300`, Scrape.do `30`, Firecrawl `30`) |
| `HOSTED_FETCH_DOMAINS` | Hosts that proactively try the hosted-fetch chain first (comma-separated) |
| `MIN_ARTICLE_TEXT_LENGTH` | Character threshold for filtering out empty/stub articles (default: `500`) |

---

## Local Development Setup

Follow these instructions to start the database, reverse proxy, and local dev services.

### Prerequisites
*   Node.js 22
*   Docker (for running the local database)
*   Caddy (for HTTPS emulation on `https://synthnews.local`)

### 1. Initial Setup
Clone the repository and install dependency workspaces:
```bash
npm install
```

### 2. Run Database Container
Launch a PostgreSQL database locally using Docker:
```bash
docker run --name newstamhv-db \
  -e POSTGRES_USER=newstamhv \
  -e POSTGRES_PASSWORD=newstamhv \
  -e POSTGRES_DB=newstamhv \
  -p 5433:5432 \
  -d postgres:16-alpine
```

### 3. Apply Migrations
Prepare the local PostgreSQL database by executing migrations:
```bash
npm run db:migrate
```

### 4. Run Development Servers
Start both the React development client and Hono API server in watch mode concurrently:
```bash
npm run dev
```

### 5. Start HTTPS Caddy Proxy
Map `127.0.0.1 synthnews.local` to your local `hosts` file, then launch Caddy:
```bash
caddy run --config Caddyfile.local
```
Open your browser to `https://synthnews.local`.

---

## Testing & Quality Verification

Run unit and integration tests across workspaces:

```bash
# Test frontend assets
npm test --workspace=client

# Test backend crawlers, schema, and API routes
npm test --workspace=server
```

---

## Production Deployment

On the target VPS hosting environment, deploy using the docker configuration:

```bash
# Pull newest changes
git pull --ff-only origin main

# Build and restart containers in background
docker compose up -d --build

# Verify container logs
docker compose logs -f app
```

---

## Cloudflare Workers Proxies

To bypass IP-based scraping blockades on sites like Reddit, VOZ, or Reuters, deploy the helper workers located at the root of the project to your Cloudflare account:

1.  **Generic Proxy**: `fetch-proxy-worker.js` (used to scrape restricted news outlets). Configure `WORKER_PROXY_URL` and `WORKER_PROXY_TOKEN` in your env.
2.  **Reddit API Worker**: `reddit-proxy-worker.js`. Configure `REDDIT_PROXY_URL`; set Worker secret `PROXY_TOKEN` to the same value as app env `WORKER_PROXY_TOKEN`.
3.  **VOZ Worker**: `voz-proxy-worker.js`. Evades Cloudflare-to-Cloudflare loops; set Worker secret `PROXY_TOKEN` to the same value as `WORKER_PROXY_TOKEN`.
4.  **Reuters Worker**: `reuters-proxy-worker.js`. Set Worker secret `PROXY_TOKEN` to the same value as `WORKER_PROXY_TOKEN`.

---

## Operational Runbook

*   **Prompt Refinement**: When editing the AI summarization prompt in `/admin`, ensure you ask the model to populate the JSON key `translated_title` so headlines translate correctly.
*   **First Run Configuration**: After deploying a fresh installation, navigate to `/admin` to configure an active AI provider and add sources at `/sources`. The crawler is active immediately, but summaries require an active provider key.
*   **Hosted Fetch Keys**: To unblock DataDome/Cloudflare sites, set any of `SCRAPINGANT_API_KEY`, `SCRAPEDO_API_KEY`, or `FIRECRAWL_API_KEY`. The chain auto-activates on anti-bot blocks; add a new provider by setting its env key, no code change needed. The winning provider is recorded in each article's `metadata.extractor`.
*   **Debugging Blank Images**: The Hono backend serves an image proxy at `/api/img/*` to resize, clean up headers, and secure image fetches. Check logs on the backend if images do not render in the detail pages.

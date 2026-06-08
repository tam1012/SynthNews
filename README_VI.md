# SynthNews

Language: [🇺🇸 English](./README.md) | [🇻🇳 Tiếng Việt](./README_VI.md)

---

SynthNews là hệ thống đọc tin cá nhân dạng full-stack monorepo. Ứng dụng lấy bài từ RSS, web, Reddit và VOZ, lưu vào PostgreSQL, dùng AI để tóm tắt tiếng Việt, rồi hiển thị trong giao diện đọc nhanh cho desktop và mobile.

Project này được thiết kế cho nhu cầu tự host cá nhân: ít thao tác, đọc nhanh, có khu quản trị gọn, có cron nền, có deploy Docker Compose trên VPS.

## Mục Lục

- [Tính năng chính](#tính-năng-chính)
- [Kiến trúc](#kiến-trúc)
- [Tech stack](#tech-stack)
- [Cấu trúc repo](#cấu-trúc-repo)
- [Luồng dữ liệu](#luồng-dữ-liệu)
- [Frontend](#frontend)
- [Backend API](#backend-api)
- [Database](#database)
- [AI providers](#ai-providers)
- [Biến môi trường](#biến-môi-trường)
- [Chạy local](#chạy-local)
- [Test và build](#test-và-build)
- [Deploy production](#deploy-production)
- [Thiết lập lần đầu](#thiết-lập-lần-đầu)
- [Nginx, HTTPS và cache](#nginx-https-và-cache)
- [GitHub Actions](#github-actions)
- [Cron jobs](#cron-jobs)
- [Scraping Reddit và VOZ](#scraping-reddit-và-voz)
- [Auth và bảo mật](#auth-và-bảo-mật)
- [Tùy chỉnh domain](#tùy-chỉnh-domain)
- [Ghi chú vận hành](#ghi-chú-vận-hành)

## Tổng Quan Vận Hành

- Production chạy bằng `docker compose up -d --build`.
- Docker expose app nội bộ tại `127.0.0.1:3001`, Nginx reverse proxy ra HTTPS.
- Backend serve luôn frontend build từ `server/public`, đồng thời expose API dưới `/api/*`.
- Deep link đang có route thật trong SPA: `/article/:articleId`, `/voz`, `/reddit`, `/digest`.
- `/article/:id` có Open Graph meta server-side khi chạy production build, dùng `PUBLIC_SITE_URL` để sinh URL chia sẻ.
- Static assets trong `/assets/*` có `Cache-Control: public, max-age=31536000, immutable`.
- API/static text được nén bởi Hono `compress()`, phía Nginx cũng bật gzip.
- **Timezone**: Container chạy `Asia/Ho_Chi_Minh` (set qua `TZ` trong `docker-compose.yml` + `tzdata` trong Dockerfile). Mọi cron schedule đọc theo giờ Việt Nam.

## Tính Năng Chính

### Đọc tin

- Tab `News`, `Tech News`, `VOZ`, `Reddit`, `Bản tin`.
- Split view trên desktop: danh sách bên trái, nội dung bên phải.
- Bottom tab bar trên mobile, auto-hide toolbar khi cuộn, detail overlay có gesture kéo xuống để đóng.
- Deep link bài viết qua `/article/:id`.
- Lọc theo nguồn tin và chủ đề.
- Điều hướng theo ngày có bài, điều hướng bàn phím giữa các bài.
- Đánh dấu bài đã đọc bằng `localStorage`.
- Thumbnail trong feed khi ảnh đủ hữu ích, image proxy server-side.
- Copy link bài gốc, mở bài gốc, nút chia sẻ Web Share API.
- Thanh reading progress khi đọc bài dài.
- Swipe trái/phải để chuyển bài trên mobile.
- Dark mode (GitHub palette) / light mode.
- Chỉnh cỡ chữ qua Settings sheet.
- Skeleton riêng cho feed và article detail, giúp hard refresh deep link không bị nhảy layout.
- Lazy-load routes cho Sources và Admin.

### Thu thập và xử lý tin

- RSS parser cho nguồn RSS chuẩn.
- Web scraper với AI-learned selector profiles: tự học CSS selector từ HTML lần đầu, cache lại cho lần sau.
- **Web source không cần selector thủ công**: nguồn web chỉ cần URL section (vd `https://www.reuters.com/world/`) là cào được — html-fetcher tự động dùng heuristic link scoring + sitemap discovery, không bắt buộc `articleLinkSelector` trong `parser_config` nữa.
- **Content extraction 3 tầng**: AI selector → cheerio CSS selectors → Mozilla Readability fallback.
- **Quality gate**: chặn insert bài có content quá ngắn trước khi vào DB, tránh tạo summary rỗng.
- **Fetch fallback nhiều tầng**: HTTP native → Googlebot UA → cookie-aware redirect fetch → Cloudflare Worker proxy → Scrapling stealth browser sidecar → Scrapling + residential proxy → Scrapling + residential proxy + Cloudflare solve → configured cookie + residential proxy → archive.today cho paywall → **hosted fetch chain**. Mỗi tầng tự kích hoạt khi tầng trước bị block/timeout.
- **Reuters/DataDome thực tế**: Reuters ưu tiên dùng residential proxy kèm cookie/header được warm từ browser profile trên VPS. Cookie runtime nằm trong Docker volume `reuters_cookie_runtime`; worker `reuters-cookie-refresh` tự refresh/verify định kỳ, còn service thủ công `reuters-profile-browser` chỉ mở khi cần anh solve DataDome/captcha lại qua noVNC.
- **Block-triggered escalation**: bất kỳ site nào fail hết các tầng free *vì bị anti-bot chặn* (HTTP 4xx hoặc trang challenge Cloudflare/DataDome) sẽ tự động nhảy lên hosted fetch — không cần thêm domain bằng tay. Bài ngắn thật/404 thì KHÔNG escalate, để tiết kiệm credit. `HOSTED_FETCH_DOMAINS` (kế thừa `FIRECRAWL_DOMAINS`) còn dùng làm allowlist chủ động cho các site cứng.
- **Rate limiting**: per-domain throttle 10s giữa các request cùng domain, 1.5s giữa domain khác nhau. Configurable qua `FETCH_PER_DOMAIN_DELAY_MS`.
- **Rescue job**: tự tìm bài cũ bị skipped vì thiếu content, requeue fetch lại và cập nhật article gốc.
- GitHub Trending scraper riêng.
- Reddit scraper theo hướng RSS + enrich comment theo nhiều fallback.
- VOZ scraper riêng: lấy RSS thread, mở thread thật, đọc nhiều page, chọn comment nổi bật.
- **Promo filter hybrid**: keyword filter chặn bài quảng cáo/deal ở bước discover (zero-cost), AI classify catch-all ở bước summarize.
- Article fetch queue 2 pha: discover URL trước, fetch nội dung sau.
- Forum rescrape cho Reddit/VOZ trong vài giờ đầu để cập nhật comment mới.
- AI tóm tắt theo prompt riêng cho tin báo và forum, prompt config quản lý qua admin.
- TLDR được trích từ structured JSON output hoặc tag `<tldr>` legacy.
- Dịch tiêu đề bài viết nước ngoài sang tiếng Việt bằng AI trong bước tóm tắt bài viết, hỗ trợ hiển thị song song tiêu đề dịch và tiêu đề gốc ở trang chi tiết.
- Digest định kỳ gom các bài đã tóm tắt trong 24 giờ gần nhất.
- Source auto-detect: nhập URL, backend tự nhận diện loại source (RSS, Reddit, VOZ, GitHub, web).

### Quản trị

- Trang `/sources` quản lý nguồn tin, auto-detect loại source.
- Trang `/admin` xem health, source quality, forum stats, trigger job thủ công, quản lý AI provider, prompt config và bài viết.
- Token admin lưu ở `localStorage` key `admin_token` khi nhập qua prompt.

## Kiến Trúc

Repo là monorepo npm workspaces:

- `client/`: React + Vite SPA.
- `server/`: Hono API, PostgreSQL, cron jobs, scraper, summarizer.
- `Dockerfile`: multi-stage build client và server.
- `docker-compose.yml`: PostgreSQL + Scrapling sidecar + app container.
- `nginx-synthnews.conf`: reverse proxy production cho `synthnews.site`.

Production flow:

```text
Browser
  -> Nginx HTTPS
  -> 127.0.0.1:3001
  -> Hono app container
  -> /api/* hoặc static frontend
  -> PostgreSQL container
```

Dockerfile build flow:

```text
client/src -> Vite build -> client/dist
server/src -> TypeScript build -> server/dist
client/dist -> copy vào server/public
container start -> node dist/db/migrate.js && node dist/index.js
```

## Tech Stack

Frontend:

- React 19
- React Router 7
- Vite 6
- TypeScript
- react-markdown
- CSS thuần trong `client/src/styles/global.css`

Backend:

- Node.js 22
- Hono
- PostgreSQL qua `pg`
- node-cron
- rss-parser
- cheerio
- Scrapling Python sidecar (stealth browser fetch, Cloudflare bypass)
- playwright (fallback khi Scrapling unavailable)
- Hosted fetch chain: ScrapingAnt + Scrape.do + Firecrawl, riêng DataDome dùng Scrape.do → Firecrawl → ScrapingAnt residential; Reuters hiện ưu tiên cookie warm + residential proxy trước khi dùng hosted provider.
- @mozilla/readability + jsdom (content extraction fallback)
- sharp (image processing)

DevOps:

- Docker
- Docker Compose
- Nginx
- GitHub Actions SSH deploy

## Cấu Trúc Repo

```text
.
├── .github/workflows/deploy.yml
├── client/
│   ├── index.html
│   ├── public/
│   ├── src/
│   │   ├── components/
│   │   │   ├── Layout.tsx          # Layout chính + bottom tabs mobile
│   │   │   └── layoutShell.ts      # Helper xác định layout mode
│   │   ├── hooks/useApi.ts         # Hook gọi API + cache
│   │   ├── pages/
│   │   │   ├── Home.tsx            # Trang đọc tin chính (tất cả tabs)
│   │   │   ├── Admin.tsx           # Trang quản trị (lazy-loaded)
│   │   │   ├── Sources.tsx         # Quản lý nguồn tin (lazy-loaded)
│   │   │   └── homeUx.ts           # UX helper cho Home
│   │   ├── services/
│   │   │   ├── api.ts              # API client
│   │   │   ├── apiCache.ts         # In-memory cache policy
│   │   │   ├── persistentCache.ts  # localStorage fallback cache
│   │   │   └── serviceWorker.ts    # PWA service worker registration
│   │   ├── styles/global.css       # Toàn bộ CSS
│   │   ├── main.tsx
│   │   └── router.tsx
│   └── tests/
├── server/
│   ├── src/
│   │   ├── db/
│   │   │   ├── index.ts            # PostgreSQL connection
│   │   │   ├── migrate.ts          # Migration runner
│   │   │   └── migrations/         # 15 SQL migration files
│   │   ├── jobs/scheduler.ts       # Cron scheduler + job lock
│   │   ├── lib/
│   │   │   ├── auth.ts             # Auth middleware + rate limit
│   │   │   ├── htmlEntities.ts     # HTML entity decode + mojibake repair
│   │   │   ├── promoFilter.ts      # Keyword + AI promo detection
│   │   │   ├── promptConfig.ts     # Prompt config types
│   │   │   ├── summaryOutput.ts    # AI output parser (JSON + legacy)
│   │   │   ├── summaryRetryPolicy.ts # Retry/backoff logic
│   │   │   ├── articleFilters.ts   # Article display filters
│   │   │   ├── sourceResolver.ts   # Source auto-detect
│   │   │   ├── imageProxy.ts       # Server-side image proxy
│   │   │   ├── openGraph.ts        # OG meta injection
│   │   │   ├── jobLock.ts          # Mutex cho cron jobs
│   │   │   ├── rateLimit.ts        # Rate limiter
│   │   │   ├── tldr.ts             # TL;DR extraction
│   │   │   └── utils.ts
│   │   ├── routes/
│   │   │   ├── health.ts           # Health + manual trigger
│   │   │   ├── articles.ts
│   │   │   ├── sources.ts          # CRUD + scrape + detect
│   │   │   ├── digests.ts
│   │   │   ├── settings.ts         # Prompt config admin
│   │   │   ├── image-proxy.ts      # /api/img/* proxy
│   │   │   └── ai-providers.ts
│   │   ├── services/
│   │   │   ├── scraper.ts          # Scraping orchestrator
│   │   │   ├── summarizer.ts       # AI summarization + promo classify
│   │   │   ├── ai-client.ts        # Multi-provider AI client
│   │   │   ├── article-fetch-queue.ts # 2-phase fetch queue + rescue
│   │   │   ├── prompt-settings.ts  # Prompt config DB access
│   │   │   ├── rescrape.ts         # Forum rescrape
│   │   │   └── fetchers/
│   │   │       ├── rss-fetcher.ts      # RSS + Readability + browser fallback
│   │   │       ├── html-fetcher.ts     # Web scraper + promo filter
│   │   │       ├── forum-fetchers.ts   # Reddit + VOZ logic
│   │   │       ├── forum-utils.ts      # Shared forum comment utilities
│   │   │       ├── reddit-fetcher.ts   # Reddit fetcher re-export
│   │   │       ├── voz-fetcher.ts      # VOZ fetcher re-export
│   │   │       ├── github-trending-fetcher.ts # GitHub Trending
│   │   │       ├── selector-learning.ts  # AI selector learning
│   │   │       ├── selector-profile.ts   # Selector cache/profile
│   │   │       ├── article-writer.ts     # DB insert + quality gate
│   │   │       ├── http-utils.ts         # HTTP fetch + Playwright fallback
│   │   │       ├── scrapling-fetch.ts    # Scrapling sidecar client + fallback (+ residential proxy passthrough)
│   │   │       ├── hosted-fetch.ts        # Hosted fetch chain; DataDome dùng Scrape.do → Firecrawl → ScrapingAnt residential
│   │   │       ├── registry.ts           # Fetcher routing
│   │   │       └── types.ts
│   │   └── index.ts                # Server entry point
│   └── tests/                      # 16 test files (58 tests)
├── scripts/                        # Local dev/helpers, gồm Reuters cookie refresh/warm profile scripts
├── Dockerfile
├── docker-compose.yml
├── nginx-synthnews.conf            # Nginx config mẫu
├── fetch-proxy-worker.js          # Cloudflare Worker generic proxy (Yahoo, NYT, etc.)
├── reddit-proxy-worker.js          # Cloudflare Worker cho Reddit proxy
├── voz-proxy-worker.js             # Cloudflare Worker cho VOZ proxy
├── reuters-proxy-worker.js         # Cloudflare Worker cho Reuters proxy
├── scrapling-sidecar/              # Python Scrapling anti-bot fetch service
├── .env.example
├── .env.local.example              # Local dev env template
├── Caddyfile.local                 # Local HTTPS proxy
├── package.json
└── README.md
```

Một số script debug nằm trong `scripts/debug/` là artifact vận hành cục bộ, đã được `.gitignore` loại khỏi repo.

## Luồng Dữ Liệu

### 1. Scrape

`startCronJobs()` gọi `runScrapeJob()` mỗi 5 phút và chạy thêm một lượt sau khi server khởi động 30 giây để kiểm tra source nào đến hạn.

Mỗi source có lịch riêng bằng `fetch_interval_minutes` và `next_run_at`:

- Source mới mặc định `fetch_interval_minutes = 60`, tức 1 giờ/lần.
- Mỗi lần scrape thành công, source được đặt `next_run_at = NOW() + fetch_interval_minutes` kèm jitter nhỏ để rải tải.
- Nếu scrape có lỗi một phần, lượt sau bị giãn gấp đôi interval, tối đa 24 giờ.
- Nếu scrape fail hẳn, `consecutive_failures` tăng và dùng exponential backoff, tối đa 24 giờ.
- Cron chính kiểm tra mỗi 5 phút, nên source quá hạn sẽ được pick trong lượt gần nhất thay vì chờ tới giờ tròn.

`runScrapeJob()` chỉ lấy source đang bật và đã đến hạn:

```sql
SELECT id, type, name, url, language, category, fetch_interval_minutes, parser_config
FROM sources
WHERE is_enabled = true
  AND (next_run_at IS NULL OR next_run_at <= NOW())
ORDER BY COALESCE(next_run_at, created_at) ASC, name ASC
```

Sau đó `scrapeSource()` hoặc fetcher chuyên biệt chọn nhánh xử lý:

- URL Reddit -> `scrapeRedditSource()`
- URL VOZ -> `scrapeVozSource()`
- `type = rss` -> `scrapeRssSource()`
- `type = web` -> `scrapeWebSource()`

Bài mới được insert vào `articles` với `summary_status = 'pending'`. Insert dùng `ON CONFLICT (url) DO NOTHING RETURNING id`, nên metric `itemsInserted` chỉ tính bài thực sự mới.

### 2. Summarize

`summarizePendingArticles()` claim bài pending bằng query atomic:

```sql
FOR UPDATE SKIP LOCKED
```

Bài được chuyển ngay sang `processing` trước khi gọi AI. Trạng thái sau xử lý:

- `done`: có summary.
- `skipped`: bài thường quá ngắn, không đủ dữ liệu.
- `failed`: lỗi AI/provider/timeout.
- `pending`: chờ xử lý hoặc được reset retry.
- `processing`: đang được worker xử lý.

### 3. Digest

`generateDigest()` lấy tối đa `DIGEST_ARTICLE_LIMIT` bài `done` trong 24 giờ gần nhất, mặc định 100 bài, gọi AI tạo bản tin markdown, lưu vào `digests` và map qua `digest_items`.

## Frontend

Routes chính trong `client/src/router.tsx`:

| Route | Mục đích |
|---|---|
| `/` | Tab News |
| `/voz` | Tab VOZ |
| `/reddit` | Tab Reddit |
| `/digest` | Tab Bản tin |
| `/article/:articleId` | Deep link bài viết |
| `/sources` | Quản lý nguồn (lazy-loaded) |
| `/admin` | Quản trị hệ thống (lazy-loaded) |

Layout chính nằm ở `client/src/components/Layout.tsx`, dùng `container-fluid` cho các route đọc tin, admin và sources để tránh lỗi co layout khi hard refresh. `client/src/components/layoutShell.ts` là helper xác định route nào dùng layout nào.

Client API cache ngắn hạn nằm ở `client/src/services/apiCache.ts`:

- `/articles*`: 60 giây.
- `/sources`: 300 giây.
- `/digests/latest*`: 60 giây.
- Endpoint mutate/admin không cache.

## Backend API

API response dùng format chung:

```json
{
  "success": true,
  "data": {},
  "meta": {}
}
```

Khi lỗi:

```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Error message"
  }
}
```

Endpoint chính:

| Nhóm | Endpoint | Auth |
|---|---|---|
| Health | `GET /api/health/live` | Public |
| Health | `GET /api/health` | Admin |
| Health | `POST /api/health/trigger/scrape` | Admin |
| Health | `POST /api/health/trigger/fetch-articles` | Admin |
| Health | `POST /api/health/trigger/summarize` | Admin |
| Health | `POST /api/health/trigger/digest` | Admin |
| Health | `POST /api/health/trigger/cleanup` | Admin |
| Sources | `GET /api/sources` | Public |
| Sources | `GET /api/sources/:id` | Public |
| Sources | `POST /api/sources` | Admin |
| Sources | `PATCH /api/sources/:id` | Admin |
| Sources | `DELETE /api/sources/:id` | Admin |
| Sources | `POST /api/sources/:id/toggle` | Admin |
| Sources | `POST /api/sources/:id/scrape` | Admin |
| Sources | `GET /api/sources/:id/scrape-status` | Admin |
| Sources | `POST /api/sources/detect` | Admin |
| Articles | `GET /api/articles/dates` | Public |
| Articles | `GET /api/articles/tags` | Public |
| Articles | `GET /api/articles` | Public |
| Articles | `GET /api/articles/:id` | Public |
| Articles | `POST /api/articles/:id/reset-summary` | Admin |
| Articles | `POST /api/articles/:id/rescrape` | Admin |
| Articles | `DELETE /api/articles/:id` | Admin |
| Digests | `GET /api/digests/latest` | Public |
| Digests | `GET /api/digests` | Public |
| Digests | `GET /api/digests/:id` | Public |
| Digests | `DELETE /api/digests/:id` | Admin |
| Settings | `GET /api/settings/prompt` | Admin |
| Settings | `GET /api/settings/prompt/default` | Admin |
| Settings | `POST /api/settings/prompt/reset` | Admin |
| Settings | `PATCH /api/settings/prompt` | Admin |
| Image Proxy | `GET /api/img/*` | Public |
| AI Providers | `/api/ai-providers/*` | Admin |

Query đáng dùng:

```bash
curl https://synthnews.site/api/health/live
curl "https://synthnews.site/api/articles?limit=3&status=done"
curl "https://synthnews.site/api/articles/dates"
curl "https://synthnews.site/api/digests/latest?lang=vi"
```

## Database

Migrations hiện có (14 file):

- `001_initial.sql` — sources, articles, scrape_logs, digests, digest_items
- `002_ai_providers.sql` — ai_providers, app_settings
- `003_add_tldr.sql` — cột tldr cho articles
- `004_add_rescraped_count.sql` — rescraped_count
- `005_article_ai_metadata.sql` — ai metadata
- `006_article_retry_state.sql` — retry state
- `007_article_fetch_jobs.sql` — article_fetch_jobs queue
- `008_allow_youtube_sources.sql` — legacy migration for previously supported YouTube source type
- `009_default_source_interval_60.sql` — default interval 60 phút
- `010_scrape_log_metadata.sql` — metadata JSONB cho scrape_logs
- `011_ai_provider_default_4096.sql` — default max_tokens
- `012_source_profiles.sql` — source_profiles cho AI-learned selectors
- `013_blocklist.sql` — blocklist URL/domain patterns
- `014_source_feed_category.sql` — feed_category (news/tech) cho sources
- `015_add_translated_title.sql` — cột translated_title cho articles để lưu tiêu đề đã dịch

Bảng chính:

- `sources`
- `articles`
- `article_fetch_jobs`
- `scrape_logs`
- `digests`
- `digest_items`
- `ai_providers`
- `source_profiles`
- `blocklist`
- `app_settings`
- `_migrations`

Local migrate:

```bash
npm run db:migrate
```

Production container tự chạy migrate trước khi start server:

```bash
node dist/db/migrate.js && node dist/index.js
```

## AI Providers

Các `provider_type` hợp lệ trong backend:

- `vertex_ai`
- `openai`
- `gemini`
- `xai`
- `mimo`
- `anthropic`
- `deepseek`
- `groq`
- `custom`

Provider active được lấy từ bảng `ai_providers`:

```sql
SELECT * FROM ai_providers WHERE is_active = true LIMIT 1
```

Lưu ý:

- `openai`, `xai`, `deepseek`, `groq`, `mimo` dùng format OpenAI-compatible.
- `custom` hỗ trợ format `openai` hoặc `gemini` qua `extra_config.format`.
- `api_key` và `service_account_json` không trả nguyên văn về frontend.
- Mỗi lần gọi AI cập nhật `total_calls`, `total_errors`, `last_used_at`, `last_error_message`.

## Biến Môi Trường

Root `.env.example` dùng cho Docker/production style. `server/.env.example` dùng cho local backend dev.

Biến quan trọng:

| Biến | Mục đích |
|---|---|
| `DB_PASSWORD` | Mật khẩu PostgreSQL trong Docker Compose |
| `PORT` | Cổng Hono server, mặc định `3000` |
| `NODE_ENV` | `development` hoặc `production` |
| `DATABASE_URL` | Connection string PostgreSQL cho server |
| `ADMIN_TOKEN` | Token admin cho endpoint mutate/protected |
| `PUBLIC_SITE_URL` | Base URL public để sinh Open Graph link |
| `CORS_ORIGIN` | Origin được phép gọi API |
| `SCRAPE_INTERVAL_HOURS` | Chu kỳ tạo digest và tránh trùng forum rescrape, mặc định `1` giờ; source discovery luôn check mỗi 5 phút |
| `MAX_ARTICLES_PER_SOURCE` | Số bài tối đa lấy từ mỗi source mỗi lượt |
| `MAX_AI_CALLS_PER_RUN` | Số bài tối đa tóm tắt mỗi lượt |
| `DIGEST_ARTICLE_LIMIT` | Số bài tối đa đưa vào mỗi bản tin, mặc định 100, trần 200 |
| `VOZ_MAX_THREAD_PAGES` | Số page VOZ tối đa đọc mỗi thread |
| `FORUM_MAX_COMMENTS` | Số comment forum tối đa đưa vào raw content |
| `FORUM_RAW_CONTENT_MAX_LENGTH` | Trần độ dài raw content forum |
| `REDDIT_COMMENT_LIMIT` | Số comment Reddit tối đa giữ lại |
| `REDDIT_COMMENT_DEPTH` | Độ sâu reply tree Reddit |
| `REDDIT_CLIENT_ID` | Reddit OAuth app client ID, optional |
| `REDDIT_CLIENT_SECRET` | Reddit OAuth app secret, optional |
| `REDDIT_USERNAME` | Reddit username, optional |
| `REDDIT_PASSWORD` | Reddit password, optional |
| `REDDIT_PROXY_URL` | Cloudflare Worker proxy URL, optional |
| `WORKER_PROXY_URL` | URL Cloudflare Worker generic proxy, optional |
| `WORKER_PROXY_TOKEN` | Auth token cho Worker proxy, optional |
| `WORKER_PROXY_SKIP_DOMAINS` | Domains không dùng Worker proxy (comma-separated), optional |
| `SCRAPLING_SERVICE_URL` | Scrapling sidecar URL, mặc định `http://scrapling:8000` trong Docker |
| `SCRAPLING_TIMEOUT_MS` | Timeout cho Scrapling requests, mặc định `60000` |
| `SCRAPLING_PROXY_URL` | Residential/rotating proxy cho các domain bị chặn cứng, route qua Scrapling. Format `http://user:pass@host:port`, optional |
| `SCRAPLING_PROXY_DOMAINS` | Allowlist host dùng residential proxy (comma-separated), để không tốn băng thông proxy cho site chạy tốt từ IP VPS |
| `REUTERS_COOKIE_HEADER_B64_FILE` | File base64 cookie/header runtime cho Reuters, mặc định `/app/runtime/reuters-cookie/reuters-cookie.b64` trong shared Docker volume |
| `REUTERS_COOKIE_HEADER_B64` | Cookie/header Reuters base64 tĩnh để bootstrap lần đầu; runtime file sẽ được ưu tiên hơn khi có |
| `REUTERS_COOKIE_REFRESH_INTERVAL_SECONDS` | Chu kỳ worker refresh/verify Reuters cookie, mặc định `21600` giây |
| `REUTERS_COOKIE_REFRESH_COOLDOWN_SECONDS` | Cooldown tránh refresh quá dày sau lần verify OK, mặc định `900` giây |
| `REUTERS_COOKIE_VERIFY_URL` | URL dùng để verify Reuters cookie, mặc định `https://www.reuters.com/world/` |
| `SCRAPINGANT_API_KEY` | API key ScrapingAnt (hosted fetch, free ~10k credit/tháng), optional |
| `SCRAPINGANT_MAX_PER_DAY` | Trần số request ScrapingAnt mỗi 24 giờ, mặc định `300` |
| `SCRAPINGANT_RESIDENTIAL_MAX_PER_DAY` | Trần riêng cho ScrapingAnt residential, mặc định `15`; chỉ dùng cuối chain cho DataDome |
| `SCRAPEDO_API_KEY` | API key Scrape.do (hosted fetch, free ~1k credit/tháng), optional |
| `SCRAPEDO_MAX_PER_DAY` | Trần số request Scrape.do mỗi 24 giờ, mặc định `30` |
| `FIRECRAWL_API_KEY` | API key Firecrawl, một provider trong hosted fetch chain, optional |
| `FIRECRAWL_API_URL` | Base URL Firecrawl, mặc định `https://api.firecrawl.dev` |
| `FIRECRAWL_MAX_PER_DAY` | Trần số request Firecrawl mỗi 24 giờ, mặc định `30` |
| `HOSTED_FETCH_DOMAINS` | Allowlist host luôn thử hosted fetch chủ động (comma-separated), kế thừa `FIRECRAWL_DOMAINS` |
| `DATADOME_DOMAINS` | Host DataDome/hard-bot, mặc định `reuters.com,bloomberg.com`; hosted chain riêng và logic cookie/proxy dựa vào danh sách này |
| `FETCH_PER_DOMAIN_DELAY_MS` | Delay tối thiểu giữa requests cùng domain, mặc định `10000` |
| `BLOCKED_DOMAINS` | Danh sách domain bị chặn (comma-separated), override default nếu set |
| `MIN_ARTICLE_TEXT_LENGTH` | Ngưỡng tối thiểu content để insert article, mặc định `500` chars |
| `ARTICLE_BROWSER_FETCH_TIMEOUT_MS` | Timeout cho browser fetch fallback, mặc định `30000` |
| `MAX_ARTICLE_FETCH_JOBS_PER_RUN` | Số fetch jobs xử lý mỗi lượt, mặc định `30` |
| `SOURCE_SCRAPE_TIMEOUT_MS` | Timeout tổng cho mỗi source scrape, mặc định auto theo loại source |
| `FORUM_MIN_COMMENTS` | Số comment tối thiểu để giữ bài forum VOZ, mặc định `10` |
| `REDDIT_MIN_COMMENTS` | Số comment tối thiểu để giữ bài Reddit, mặc định `5` |
| `IMAGE_CACHE_MAX_MB` | Giới hạn cache ảnh proxy trên đĩa, mặc định `200` MB |

Default cần chú ý:

- `docker-compose.yml` fallback production: `VOZ_MAX_THREAD_PAGES=15`, `FORUM_MAX_COMMENTS=70`, `FORUM_RAW_CONTENT_MAX_LENGTH=80000`.
- `.env.example` hiện để giá trị thận trọng hơn: `4`, `40`, `60000`. Nếu copy `.env.example` sang `.env`, giá trị trong `.env` sẽ override fallback của Compose.
- Production yêu cầu `ADMIN_TOKEN` không được rỗng hoặc là token mẫu yếu. Nếu yếu, server sẽ crash khi `NODE_ENV=production`.

Ví dụ `.env` cho Docker:

```env
DB_PASSWORD=thay-bang-mat-khau-manh
ADMIN_TOKEN=thay-bang-token-dai-ngau-nhien
PUBLIC_SITE_URL=https://your-domain.example.com
CORS_ORIGIN=https://your-domain.example.com
SCRAPE_INTERVAL_HOURS=3
MAX_ARTICLES_PER_SOURCE=20
MAX_AI_CALLS_PER_RUN=30
DIGEST_ARTICLE_LIMIT=100
VOZ_MAX_THREAD_PAGES=15
FORUM_MAX_COMMENTS=70
FORUM_RAW_CONTENT_MAX_LENGTH=80000
REDDIT_COMMENT_LIMIT=30
REDDIT_COMMENT_DEPTH=3
```

Ví dụ `server/.env` cho local dev:

```env
PORT=3000
NODE_ENV=development
DATABASE_URL=postgresql://newstamhv:newstamhv@localhost:5432/newstamhv
ADMIN_TOKEN=dev-admin-token-change-this
SCRAPE_INTERVAL_HOURS=3
MAX_ARTICLES_PER_SOURCE=20
MAX_AI_CALLS_PER_RUN=30
DIGEST_ARTICLE_LIMIT=100
```

## Chạy Local

Yêu cầu:

- Node.js 22+
- npm
- PostgreSQL local hoặc Docker

Cài dependencies:

```bash
npm install
```

Chạy PostgreSQL nhanh bằng Docker:

```bash
docker run --name newstamhv-db \
  -e POSTGRES_USER=newstamhv \
  -e POSTGRES_PASSWORD=newstamhv \
  -e POSTGRES_DB=newstamhv \
  -p 5433:5432 \
  -d postgres:16-alpine
```

Khi dùng cổng `5433`, đặt:

```env
DATABASE_URL=postgresql://newstamhv:newstamhv@localhost:5433/newstamhv
```

Migrate:

```bash
npm run db:migrate
```

Chạy full dev:

```bash
npm run dev
```

Chạy riêng:

```bash
npm run dev --workspace=server
npm run dev --workspace=client
```

## Test Và Build

Client tests:

```bash
npm test --workspace=client
```

Server tests:

```bash
npm test --workspace=server
```

Build toàn bộ:

```bash
npm run build
```

Build riêng:

```bash
npm run build --workspace=client
npm run build --workspace=server
```

Root scripts hiện tại:

| Script | Lệnh |
|---|---|
| `npm run dev` | Chạy server và client song song |
| `npm run build` | Build client rồi server |
| `npm run start` | Start server dist |
| `npm run db:migrate` | Chạy migrations server |
| `npm run local:build` | Build + copy client vào server/public |
| `npm run local:prod` | Build + start bản production local |
| `npm run local:start` | Start server từ `.env.local` |
| `npm run local:check-hosts` | Kiểm tra hosts local cho `synthnews.local` |

## Deploy Production

Trên VPS:

```bash
cd /home/ubuntu/newstamhv
git pull --ff-only origin main
docker compose up -d --build
docker compose ps
docker compose logs -f app
```

Compose services:

- `db`: PostgreSQL 16 Alpine, volume `pgdata`, bind local `127.0.0.1:5433`.
- `scrapling`: Python Scrapling sidecar, anti-bot fetch service, internal network only.
- `app`: SynthNews app, bind local `127.0.0.1:3001`, depends on DB + Scrapling healthcheck.

Healthcheck app:

```bash
curl -fsS http://127.0.0.1:3001/api/health/live
```

Public healthcheck:

```bash
curl -fsS https://your-domain.example.com/api/health/live
```

## Thiết Lập Lần Đầu

Sau khi `docker compose up -d --build` thành công:

1. **Cấu hình AI provider** — Mở `https://your-domain/admin`, nhập `ADMIN_TOKEN` khi được hỏi, rồi vào tab AI Providers. Thêm ít nhất 1 provider (ví dụ Gemini API key miễn phí). Nếu không có AI provider, hệ thống vẫn scrape nhưng mọi bài sẽ stuck ở `pending` — không có summary.

2. **Thêm nguồn tin** — Mở `https://your-domain/sources`, thêm nguồn RSS hoặc web. Backend tự nhận diện URL Reddit/VOZ và chuyển sang scraper riêng.

3. **Chờ cron hoặc trigger thủ công** — Source mới mặc định cào lại mỗi 60 phút, cron chính kiểm tra nguồn đến hạn mỗi 5 phút. Để test ngay, vào `/sources` → bấm "Cào ngay" (chạy async, trả kết quả ngay) hoặc vào `/admin` → bấm nút "Cào tin", "Fetch bài" và "Tóm tắt".

4. **Kiểm tra** — Sau khi scrape + summarize xong, bài sẽ hiện trên trang chủ với TL;DR preview.

## Nginx, HTTPS Và Cache

File mẫu Nginx reverse proxy nằm ở `nginx-synthnews.conf`. Để thiết lập trên VPS mới:

```bash
# Cài Nginx + Certbot
sudo apt install -y nginx certbot python3-certbot-nginx

# Copy config mẫu (đổi server_name trong file trước khi copy)
sudo cp nginx-synthnews.conf /etc/nginx/sites-available/myapp
sudo ln -s /etc/nginx/sites-available/myapp /etc/nginx/sites-enabled/
sudo rm /etc/nginx/sites-enabled/default

# Lấy SSL certificate
sudo certbot --nginx -d your-domain.example.com

# Test và reload
sudo nginx -t && sudo systemctl reload nginx
```

Config mẫu bao gồm:

- Reverse proxy tới `http://127.0.0.1:3001`
- Gzip cho text, CSS, JS, JSON, XML, RSS
- Security headers (HSTS, X-Frame-Options, X-Content-Type-Options)
- Redirect HTTP → HTTPS và www → non-www

Backend cũng có:

- `compress()` của Hono cho response.
- `Cache-Control: public, max-age=31536000, immutable` cho `/assets/*`.

## GitHub Actions

Workflow:

```text
.github/workflows/deploy.yml
```

Trigger:

```text
push vào main
```

Các bước chính:

- SSH vào VPS bằng `appleboy/ssh-action`.
- `cd /home/ubuntu/newstamhv`
- `git pull --ff-only origin main`
- `docker compose up -d --build`
- smoke test local API `127.0.0.1:3001`
- smoke test frontend bằng Puppeteer trong app container
- smoke test public health và articles qua `https://synthnews.site`
- `docker compose ps`

Workflow cần 3 secrets trong repo GitHub (Settings → Secrets → Actions):

| Secret | Giá trị |
|---|---|
| `VPS_HOST` | IP hoặc hostname VPS |
| `VPS_USERNAME` | User SSH (thường `ubuntu`) |
| `VPS_SSH_KEY` | Private key SSH (nội dung file `.pem`) |

Lưu ý: đổi URL smoke test public trong `deploy.yml` nếu dùng domain khác.

## Cron Jobs

`server/src/jobs/scheduler.ts` đăng ký các job khi server start. Lịch chạy theo giờ Việt Nam (container set `TZ=Asia/Ho_Chi_Minh`):

| Job | Lịch | Việc làm |
|---|---|---|
| Source discovery | `*/5 * * * *` + startup check | Kiểm tra source đến hạn theo `next_run_at`; source mặc định 60 phút/lần, có jitter nhỏ, lỗi thì backoff tối đa 24 giờ |
| Article Fetch Queue | `*/5 * * * *` | Claim URL đã discover trong `article_fetch_jobs`, fetch nội dung chi tiết (HTTP → Worker proxy → Scrapling stealth → Scrapling+residential proxy → hosted fetch chain), per-domain throttle 10s giữa mỗi request cùng domain |
| Summarize | `*/10 * * * *` | Claim bài `pending`, gọi AI, cập nhật `done/skipped/failed` |
| Forum Rescrape | `0,30 * * * *` | Cào lại Reddit/VOZ mới, bỏ qua phút `00` theo nhịp digest để giảm tải |
| Digest | `30 17,23,5,14 * * *` (UTC) = 0:30, 6:30, 12:30, 21:30 (GMT+7) | Tạo bản tin từ các bài đã tóm tắt trong 24 giờ gần nhất |
| Retry | `*/10 * * * *` | Reset bài/queue kẹt, retry failed còn hạn, retry comment Reddit, **rescue bài skipped vì content ngắn** |
| Cleanup | `43 2 * * *` | Xóa scrape logs cũ, dọn raw_content bài cũ, reset processing kẹt |

Cleanup hiện tại:

- Xóa `scrape_logs` cũ hơn 14 ngày.
- Set `raw_content = NULL` cho bài cũ hơn 60 ngày.
- Reset bài `processing` quá 10 phút về `pending`.

Forum rescrape:

- Chỉ xét source name có `reddit` hoặc `voz`.
- Chỉ xét bài tạo trong 4 giờ gần nhất.
- Mỗi bài rescrape tối đa 2 lần qua `rescraped_count`.
- Nếu content đổi, reset `summary_status = 'pending'` để AI tóm tắt lại.

## Luồng Fetch Các Nguồn Hiện Tại

### RSS article detail

`server/src/services/fetchers/rss-fetcher.ts` là pipeline chính cho bài lấy từ RSS. Thứ tự hiện tại:

1. Native HTTP với browser headers và random UA.
2. Native HTTP với Googlebot UA.
3. Cookie-aware redirect fetch cho site cần giữ `Set-Cookie` qua 302.
4. Cloudflare Worker generic proxy nếu `WORKER_PROXY_URL` được cấu hình và domain không nằm trong `WORKER_PROXY_SKIP_DOMAINS`.
5. Scrapling stealth sidecar.
6. Scrapling stealth qua residential proxy nếu các tầng trước bị block và host chưa nằm trong proxy allowlist.
7. Scrapling residential proxy + Cloudflare solve cho Cloudflare challenge thường.
8. Configured cookie + residential proxy, dùng cho Reuters/DataDome khi có cookie runtime/env.
9. archive.today cho domain paywall nằm trong `PAYWALL_ARCHIVE_DOMAINS`.
10. Hosted fetch chain nếu domain nằm trong `HOSTED_FETCH_DOMAINS` hoặc các tầng free bị anti-bot block.

Pipeline chỉ escalate lên tầng tốn tiền khi detect block thật (`401`, `403`, `429`, DataDome/Cloudflare challenge HTML). Trang 404 hoặc bài quá ngắn thật không tự đốt credit.

### Reuters/DataDome

Reuters không còn phụ thuộc chính vào Scrape.do/ScrapingAnt/Firecrawl. Đường ưu tiên hiện tại là:

```text
RSS URL -> fetch detail -> configured Reuters cookie/header -> Scrapling sidecar -> residential proxy -> extract article
```

Cookie/header Reuters được quản lý bằng Docker volume `reuters_cookie_runtime`:

- File runtime trong container: `/app/runtime/reuters-cookie/reuters-cookie.b64`.
- App đọc `REUTERS_COOKIE_HEADER_B64_FILE` trước, rồi mới tới `REUTERS_COOKIE_HEADER_B64` và `REUTERS_COOKIE_HEADER`.
- Worker `reuters-cookie-refresh` chạy định kỳ, mở Chromium persistent profile qua residential proxy, verify `REUTERS_COOKIE_VERIFY_URL`, rồi ghi cookie mới nếu `status=200` và không bị block.
- Service `reuters-profile-browser` có profile `manual`, chỉ bật khi cần người vận hành mở noVNC và solve Reuters/DataDome/captcha trong đúng browser profile trên VPS.
- Không tự đọc cookie từ Chrome local. Nếu cần bootstrap thủ công, operator tự export cookie và set bằng env/file base64.

Runbook warm lại Reuters khi bị block:

```bash
cd /home/ubuntu/newstamhv
docker compose stop reuters-cookie-refresh
docker compose --profile manual up -d --force-recreate reuters-profile-browser
```

Tạo SSH tunnel từ máy local:

```bash
ssh -i "<path-to-key>" -N -L 6080:127.0.0.1:6080 ubuntu@<vps-host>
```

Mở `http://127.0.0.1:6080/vnc.html`, bấm Connect, vào Reuters và xử lý consent/captcha nếu có. Sau khi Reuters vào được bình thường:

```bash
docker compose --profile manual stop reuters-profile-browser
docker compose up -d reuters-cookie-refresh
docker compose logs --tail=120 reuters-cookie-refresh
```

Log OK cần thấy:

```text
refresh:profile cookies=SET length=...
refresh:ok cookieHeaderLength=... verifyStatus=200
```

Nếu thấy `verify failed status=401 blocked=true`, profile/cookie đã bị Reuters/DataDome reject và cần warm lại qua noVNC.

### Hosted fetch

`server/src/services/fetchers/hosted-fetch.ts` là tầng cuối khi các tầng self-hosted bị chặn hoặc domain được allowlist chủ động.

- Host thường: ScrapingAnt datacenter → Scrape.do → Firecrawl.
- Host DataDome (`DATADOME_DOMAINS`, mặc định Reuters/Bloomberg): Scrape.do → Firecrawl → ScrapingAnt residential.
- Provider không có key hoặc vượt `*_MAX_PER_DAY` sẽ bị skip.
- Provider trả challenge/empty/429/lỗi sẽ fall through sang provider tiếp theo.

Reuters vẫn có thể rơi xuống hosted fetch nếu nhánh cookie + residential proxy thất bại, nhưng mục tiêu vận hành hiện tại là dùng warm cookie để giảm phụ thuộc vào hosted providers.

### Web source, GitHub, Reddit, VOZ

- Web source thường đi qua `html-fetcher.ts`: fetch section page, heuristic link scoring + sitemap discovery, selector profile cache, rồi article detail đi qua pipeline phía trên.
- GitHub Trending có fetcher riêng: ưu tiên native/raw README, fallback Scrapling khi GitHub page không parse được.
- Reddit có fetcher riêng, ưu tiên OAuth nếu đủ env; nếu không thì RSS/comment feed/Scrapling/proxy/archive fallback.
- VOZ có fetcher riêng, dùng RSS thread list + Scrapling stealth để mở thread/pagination, sau đó parse comment bằng Cheerio.

## Scraping Reddit Và VOZ

### Reddit

Source Reddit được add qua `/sources`. Nếu nhập URL dạng `https://www.reddit.com/r/<subreddit>`, backend tự đổi thành RSS ổn định:

```text
https://www.reddit.com/r/<subreddit>/.rss
```

Khi scrape, backend nhận diện host Reddit và dùng `scrapeRedditSource()`:

1. Lấy danh sách thread hot qua RSS.
2. Nếu có OAuth env (`REDDIT_CLIENT_ID`, ...), gọi `oauth.reddit.com` — truy cập đầy đủ comment + score.
3. Nếu không có OAuth, enrich tối đa 8 bài mỗi lượt theo waterfall (dừng ngay khi 1 strategy thành công):
   1. **Scrapling stealth** vào `old.reddit.com/...json` — lấy được JSON đầy đủ qua stealth browser.
   2. **RSS Comment Feed** `reddit.com/{postPath}.rss` — **strategy đáng tin nhất** trên hầu hết môi trường. Lấy được nội dung comment đầy đủ, tuy không có upvote score (mặc định `0 điểm`).
   3. **Cloudflare Worker proxy** qua `REDDIT_PROXY_URL` — chỉ dùng nếu cả 2 trên fail. Cần deploy `reddit-proxy-worker.js` lên Workers trước.
   4. **Pullpush archive API** — fallback cuối, data thường bị delay hoặc stale.
4. Flatten comment tree, lọc `[deleted]`, `[removed]`, comment quá ngắn.
5. Score comment theo reaction/length/độ sớm/depth.
6. Chọn top comment, rồi sắp lại theo thứ tự xuất hiện để đưa vào `raw_content`.

> **Lưu ý thực tế:** Scrapling stealth browser xử lý hầu hết các site có Cloudflare protection. Nếu Scrapling service down, hệ thống tự fallback về Playwright. RSS Comment Feed là strategy đáng tin nhất cho comment Reddit. Proxy và Pullpush hiếm khi cần thiết.

Retry Reddit mỗi 10 phút tìm bài trong 48 giờ gần nhất có raw content chứa `Đã trích 0 comment`, thử Pullpush lại, rồi reset summary nếu enrich được comment.

### VOZ

VOZ dùng `scrapeVozSource()`:

1. Lấy danh sách thread từ RSS.
2. Fetch thread HTML qua Scrapling stealth sidecar (bypass Cloudflare). Fallback về Playwright nếu Scrapling unavailable.
3. Parse HTML bằng Cheerio.
4. Đọc pagination tối đa `VOZ_MAX_THREAD_PAGES`.
5. Tách OP và comment thành viên.
6. Score, dedupe, chọn `FORUM_MAX_COMMENTS` comment nổi bật.
7. Ghép raw content gồm bài gốc, metadata thread và bình luận tiêu biểu.

Sleep mặc định giữa các page VOZ là 500ms.

## Auth Và Bảo Mật

Middleware auth nằm ở `server/src/lib/auth.ts`.

Luật hiện tại:

- `GET /api/health/live` public.
- `GET` public cho articles, sources, digests.
- `/api/health` và `/api/ai-providers` cần auth cho mọi method, kể cả GET.
- Mọi method không phải GET đều cần `Authorization: Bearer <ADMIN_TOKEN>`.

Frontend sẽ prompt token khi gặp `UNAUTHORIZED`, rồi lưu vào `localStorage`.

Không đưa các file này lên repo:

- `.env`
- `.env.*` trừ `.env.example`
- `*.pem`
- `*.key`
- file SQL thủ công ngoài migrations

`.gitignore` hiện đã chặn các nhóm file trên.

## Tùy Chỉnh Domain

Nếu dùng domain riêng (không phải domain mẫu trong repo), cập nhật đồng bộ:

1. `.env` → `PUBLIC_SITE_URL` và `CORS_ORIGIN`
2. `nginx-synthnews.conf` → `server_name` (hoặc tạo file config riêng)
3. `.github/workflows/deploy.yml` → URL smoke test public (dòng cuối)
4. Chạy `certbot` lấy SSL cho domain mới
5. Reload Nginx: `sudo nginx -t && sudo systemctl reload nginx`

## Ghi Chú Vận Hành

- Nếu sửa frontend layout đọc tin, kiểm tra hard refresh các route `/`, `/voz`, `/reddit`, `/digest`, `/article/:id`.
- Nếu sửa Open Graph hoặc deep link, kiểm tra production build vì server chỉ inject meta khi có `server/public/index.html`.
- Nếu sửa ảnh bài viết, kiểm tra ảnh lỗi/placeholder để không còn khung ảnh trống lớn trong article detail.
- Nếu sửa prompt tóm tắt, kiểm tra giữ tên riêng như `Vietnam Game Awards`, `VNGGames`, `Funtap Games` và dịch cụm mô tả phổ biến như `Strait of Hormuz` → `Eo biển Hormuz`. Đồng thời, đảm bảo prompt yêu cầu AI trả về trường JSON `translated_title` để hệ thống lưu được tiêu đề dịch.
- Nếu dùng cache assets 1 năm, file build phải có hash như Vite mặc định. Không cache immutable cho HTML.
- Nếu AI provider trả summary không có `<tldr>`, bài vẫn có summary nhưng list preview sẽ fallback sang excerpt/summary.
- Nếu source Reddit/VOZ thiếu comment lúc mới scrape, forum rescrape và retry job sẽ có cơ hội cập nhật lại trong vài giờ đầu.
- `reddit-proxy-worker.js` trong repo là Cloudflare Worker dùng bypass Reddit IP block. Deploy lên Cloudflare Workers rồi set `REDDIT_PROXY_URL` nếu cần; Worker secret `PROXY_TOKEN` phải trùng với app env `WORKER_PROXY_TOKEN`.
- `fetch-proxy-worker.js` là generic Cloudflare Worker proxy cho các domain bị block IP datacenter (Yahoo, NYT, v.v.). Deploy rồi set `WORKER_PROXY_URL` và `WORKER_PROXY_TOKEN`. Reuters hiện ưu tiên warm cookie + residential proxy; Worker chỉ là tầng phụ nếu được cấu hình.
- `voz-proxy-worker.js` là Cloudflare Worker proxy cho VOZ (bypass Cloudflare-to-Cloudflare challenge); Worker secret `PROXY_TOKEN` phải trùng với app env `WORKER_PROXY_TOKEN`.
- `reuters-proxy-worker.js` là Cloudflare Worker proxy riêng cho Reuters; Worker secret `PROXY_TOKEN` phải trùng với app env `WORKER_PROXY_TOKEN`. Hiện đây không phải đường chính cho Reuters vì DataDome cần cookie/profile hợp lệ.
- **Reuters cookie refresh**: kiểm tra bằng `docker compose logs --tail=120 reuters-cookie-refresh`. Trạng thái tốt là `refresh:ok ... verifyStatus=200`; nếu `status.json` báo `blocked=true` hoặc `status=401`, mở `reuters-profile-browser` theo runbook trong mục "Luồng Fetch Các Nguồn Hiện Tại".
- **Hosted fetch chain** (`server/src/services/fetchers/hosted-fetch.ts`): tầng fetch cuối khi mọi tầng free/self-hosted bị anti-bot chặn. Host thường thử ScrapingAnt datacenter → Scrape.do → Firecrawl. DataDome hosts thử Scrape.do → Firecrawl → ScrapingAnt residential. Provider nào không có key hoặc chạm trần `*_MAX_PER_DAY` (rolling 24 giờ) thì bị bỏ qua; provider trả 429/lỗi/trang rỗng/challenge thì nhảy provider kế. Tên provider thắng được ghi vào `metadata.extractor` của bài. Thêm key mới chỉ cần set env, không phải sửa code.
- **Blocklist**: quản lý URL/domain patterns bị chặn qua `/api/blocklist`. Bài từ URL match pattern sẽ bị skip ở bước discover và fetch.

# Báo cáo Audit hợp nhất - NewsTamHV / SynthNews

**Ngày audit:** 2026-06-02  
**Phạm vi:** toàn bộ monorepo `client`, `server`, Python Scrapling sidecar, Cloudflare Workers proxy, Docker/Nginx/GitHub Actions, và đối chiếu runtime production trên Oracle VPS Singapore.  
**Nguồn hợp nhất:** `AUDIT_TONGHOP_newstamhv_2026-06-02.md` do Claude/Kiro tạo, `FULL_AUDIT_CODE_REVIEW_SYNTHNEWS_2026-06-02.md` do Codex tạo, hai review cũ tháng 5, và các kiểm tra local/live đã chạy trong phiên audit.

> Bản này là bản hợp nhất công tâm: giữ các finding sắc của Claude/Kiro, bổ sung live evidence/verification của Codex, đồng thời hạ hoặc nâng severity ở những chỗ cần cân bằng hơn.

---

## Tóm tắt điều hành

SynthNews hiện là một codebase cá nhân nhưng đã khá trưởng thành: monorepo rõ ràng, có migrations, test suite thật, queue có `FOR UPDATE SKIP LOCKED`, deploy workflow có smoke test, auth admin đã có fail-fast token yếu, SQL hầu hết parameterized, scraper đã refactor một phần thành fetcher registry, và UI production render tốt trên desktop/mobile.

Tuy nhiên vẫn còn một nhóm rủi ro cần xử lý sớm:

- **Security/ops:** một số endpoint GET public lộ dữ liệu vận hành, AI provider keys lưu plaintext trong DB, local workspace còn secret artifacts, specialized Workers thiếu token, Scrapling sidecar thiếu auth nội bộ.
- **Container/browser:** app và sidecar đang chạy root trên VPS; Chromium/Playwright/Puppeteer chạy `--no-sandbox`; browser singleton chưa có mutex nên có nguy cơ rò process.
- **Reliability:** advisory lock có thể leak nếu unlock lỗi; sidecar error/status mapping còn thô; một nguồn scrape chậm có thể kéo dài cả batch.
- **Data correctness:** production API đang có article future-dated đứng đầu feed; local DB còn future-date nặng hơn, gây empty-state trong UI local.
- **Maintenance:** `Home.tsx`, `home.css`, `forum-fetchers.ts`, `rss-fetcher.ts`, và API client còn nhiều `any`/state phức tạp.

## Verification đã thực hiện

| Hạng mục | Kết quả |
|---|---|
| Local commit | `d7cf12d fix(scraper): cookie-gated fetch, DataDome detection, out-of-range date guard` |
| VPS commit | `d7cf12d`, trùng local |
| VPS containers | `newstamhv-app`, `newstamhv-scrapling`, `newstamhv-db` healthy |
| VPS container user | app và scrapling đều chạy `uid=0(root)` |
| Production health | `https://synthnews.site/api/health/live` OK |
| Client tests | `npm test --workspace=client` pass 56/56 |
| Server tests | `npm test --workspace=server` pass 111/111 |
| Build | `npm run build` pass |
| Dependency audit | `npm audit --workspaces --omit=dev` fail với 2 moderate advisories |
| UI local | `/`, `/sources`, `/admin` render ở 1440/768/390px, không horizontal overflow |
| UI production | Home render 40 feed items ở desktop/mobile, không console error |

---

## 🔴 Critical / High Issues

### C1. Public GET đang expose operational data

**Mức độ:** High  
**Trạng thái:** verified bằng code và production API.

Auth middleware chỉ full-protect GET cho một số prefix:

- `server/src/lib/auth.ts:7-9`: protected prefixes gồm `/api/ai-providers`, `/api/health`, `/api/settings`, `/api/blocklist`.
- `server/src/lib/auth.ts:36-47`: GET ngoài protected prefixes được public.

Các endpoint hiện public:

- `server/src/routes/sources.ts:68-78`: `/api/sources` trả `parser_config`, `last_checked_at`, `last_success_at`, `last_error_message`, `consecutive_failures`, `next_run_at`.
- `server/src/routes/articles.ts:201-242`: `/api/articles/fetch-jobs` trả queue URL/title/status/last_error.

Live evidence:

- `https://synthnews.site/api/sources` trả 200, `count=40`, có `parser_config`, `last_error_message`, `next_run_at`; 5 source có `parser_config`.
- `https://synthnews.site/api/articles/fetch-jobs?limit=1` trả 200, `total=13198`, row có `url`, `status`, queue metadata.

**Impact:** người ngoài có thể fingerprint lịch scrape, parser strategy, backlog và lỗi crawler; sau này nếu `last_error` chứa URL nội bộ/provider detail thì rủi ro tăng.

**Fix đề xuất:**

- Chuyển `/api/articles/fetch-jobs` sang admin-only GET.
- Tách `/api/sources/public` chỉ trả `id`, `name`, `type`, `is_enabled`, `feed_category`.
- Giữ `/api/sources` full detail cho admin token.

---

### C2. Containers chạy root và browser chạy `--no-sandbox`

**Mức độ:** High  
**Trạng thái:** verified trên VPS.

Evidence:

- VPS: `docker compose exec -T app id` -> `uid=0(root)`.
- VPS: `docker compose exec -T scrapling id` -> `uid=0(root)`.
- `Dockerfile:20-39` không tạo non-root user.
- `scrapling-sidecar/Dockerfile:1-23` không tạo non-root user.
- `server/src/services/fetchers/http-utils.ts:97-105` Puppeteer có `--no-sandbox`, `--disable-setuid-sandbox`.
- `server/src/services/fetchers/http-utils.ts:173-185` Playwright có `--no-sandbox`, `--disable-setuid-sandbox`.
- `.github/workflows/deploy.yml:61-75` smoke test cũng launch Chromium với `--no-sandbox`.

**Impact:** scraper/browser mở HTML từ internet, là surface rủi ro cao. Nếu Chromium/Camoufox/Playwright bị exploit, root trong container và sandbox disabled làm blast radius lớn hơn.

**Fix đề xuất:**

- Tạo non-root user cho app và sidecar.
- Chỉ cấp quyền ghi cho `/tmp/img-cache`, browser cache, app tmp dirs.
- Thử bỏ `--no-sandbox` sau khi container non-root đã ổn.
- Nếu vẫn cần `--no-sandbox`, thêm `cap_drop`, `security_opt`, read-only root filesystem, và document rõ lý do.

---

### C3. AI provider secrets lưu plaintext trong database

**Mức độ:** High  
**Trạng thái:** verified bằng migrations/routes.

Evidence:

- `server/src/db/migrations/002_ai_providers.sql:4-17`: `api_key TEXT`, `service_account_json TEXT`.
- `server/src/routes/ai-providers.ts:100-133`: insert `api_key` trực tiếp.
- `server/src/routes/ai-providers.ts:155-179`: patch `api_key` trực tiếp.
- `server/src/services/ai-client.ts:3-16`: model provider có `api_key`, `service_account_json`.
- API list/detail đã mask secret, đây là điểm tốt, nhưng chỉ bảo vệ API response chứ không bảo vệ DB dump.

**Impact:** DB compromise/backup leak sẽ kéo theo provider key compromise và billing/quota abuse.

**Fix đề xuất:**

- Envelope encryption cho provider secrets, master key từ env/secret store.
- Tách `ai_provider_secrets` hoặc ít nhất mã hóa columns hiện tại.
- Rotation provider keys sau khi migrate encryption.

---

### C4. Public feed đang bị future-dated articles chiếm thứ tự

**Mức độ:** High về data correctness/UX  
**Trạng thái:** verified bằng production và local API.

Evidence code:

- `server/src/lib/dateUtils.ts:19-26`: chỉ bound năm plausible đến `currentYear + 1`, không chặn ngày tương lai gần.
- `server/src/lib/articleFilters.ts:188-195`: sort public list theo `COALESCE(a.published_at, a.created_at) DESC`.
- `server/src/lib/articleFilters.ts:81-155`: chưa có clause chặn `published_at > NOW()`.

Live/local evidence:

- Production `/api/articles?limit=5&status=done` first article:
  - id `art_IMhYVe4SCkhAohci`
  - title `Trivial Pursuits`
  - `published_at=2026-06-04T00:00:00.000Z`
  - `local_date=2026-06-04`
  - ngày audit là 2026-06-02.
- Production `/api/articles/dates`: `futureCount=1`, first date `2026-06-04`.
- Local API first article có `local_date=2026-09-05`.
- Local Home render empty-state "Chưa có tin tức" dù API có data, do UI lọc future dates.

**Impact:** public API sai thứ tự, UI có thể hiện tin tương lai hoặc rơi empty-state, digest/summarizer có thể chọn sai bài nếu query không filter.

**Fix đề xuất:**

- Ingest policy: nếu `publishedAt > now + tolerance`, set `published_at = NULL` hoặc dùng `created_at`, lưu raw date vào metadata/warning.
- Public query policy: mặc định thêm `COALESCE(a.published_at, a.created_at) <= NOW() + INTERVAL '2 hours'`.
- Thêm tests cho `normalizeDate`, `articleFilters`, `/api/articles/dates`.
- Backfill/clean các rows future-dated hiện có sau khi chốt tolerance.

---

### C5. Specialized Cloudflare Workers thiếu token/rate limit

**Mức độ:** High/Medium tùy URL có public hay không; nên sửa sớm vì fix đơn giản.  
**Trạng thái:** verified bằng source.

Evidence:

- Generic `fetch-proxy-worker.js:79-85` làm đúng: có `PROXY_TOKEN`.
- `voz-proxy-worker.js:23-84`: không token auth.
- `reddit-proxy-worker.js:5-55`: không token auth/rate limit.
- `reuters-proxy-worker.js:22-89`: không token auth/rate limit.
- Các worker trả `Access-Control-Allow-Origin: *`.

**Impact:** nếu Worker URL bị lộ, người ngoài có thể burn quota hoặc dùng Worker làm relay tới domain allowlisted.

**Fix đề xuất:**

- Copy pattern từ `fetch-proxy-worker.js`: check `env.PROXY_TOKEN` + `X-Proxy-Token`.
- Siết CORS về domain của anh hoặc bỏ CORS nếu chỉ app server gọi.
- Thêm rate limit nếu Worker public-facing.

---

### C6. Scrapling sidecar `/fetch` thiếu auth và thiếu URL validation độc lập

**Mức độ:** High nội bộ; không nên gọi Critical tuyệt đối vì port không publish ra internet, nhưng vẫn là rủi ro đáng xử lý.  
**Trạng thái:** verified bằng source.

Evidence:

- `scrapling-sidecar/app/main.py:57-68`: nhận `req.url` và dispatch `_stealth_fetch_sync`/`_fast_fetch_sync`.
- `scrapling-sidecar/app/main.py:88-125`: truyền URL thẳng vào Scrapling.
- `docker-compose.yml:2-20`: sidecar không publish port ra host, đây là điểm giảm rủi ro.
- Node caller có guard/proxy policy, nhưng sidecar tự thân không kiểm.

**Impact:** nếu app container hoặc container cùng network bị compromise, sidecar trở thành browser SSRF primitive có thể fetch network nội bộ/link-local.

**Fix đề xuất:**

- Shared secret header giữa app và sidecar, ví dụ `X-Sidecar-Token`.
- Python sidecar tự validate URL: chỉ `http/https`, block localhost/private/link-local/metadata, optional DNS resolution.
- Có allowlist domain hoặc ít nhất denylist private CIDR.

---

### C7. Advisory lock có thể leak nếu unlock lỗi

**Mức độ:** High reliability  
**Trạng thái:** verified bằng source, chưa thấy incident live.

Evidence:

- `server/src/lib/jobLock.ts:11-29`.
- `pg_advisory_lock` là session-scoped.
- Nếu `client.query('SELECT pg_advisory_unlock($1)')` ở dòng 25 throw, `finally` ngoài vẫn `client.release()` ở dòng 28.
- Khi đó connection có thể quay lại pool trong trạng thái lock chưa nhả.

**Impact:** cron job có thể bị skip lâu dài cho đến khi app restart hoặc connection bị destroy.

**Fix đề xuất:**

- Bọc unlock trong try/catch.
- Nếu unlock fail, `client.release(true)` để destroy connection thay vì trả về pool.
- Log severity rõ ràng.

---

### C8. Browser singleton chưa có mutex/promise-cache

**Mức độ:** High reliability/resource leak  
**Trạng thái:** verified bằng source, chưa thấy incident live trong audit.

Evidence:

- `server/src/services/fetchers/http-utils.ts:93-107`: `pupBrowserInstance` singleton nhưng không mutex.
- `server/src/services/fetchers/http-utils.ts:166-187`: `pwBrowser` singleton nhưng không mutex.
- Hai caller đồng thời có thể cùng thấy browser null/disconnected và cùng launch; instance bị ghi đè, process còn lại có thể mồ côi.

**Impact:** nguy cơ rò Chromium process/RAM/PID trong các đợt scrape/fetch song song.

**Fix đề xuất:**

- Dùng promise-cache:
  - `let pwBrowserPromise: Promise<ChromiumBrowser> | null`
  - nếu đang launch, caller sau `await` cùng promise.
  - reset promise khi launch fail hoặc browser disconnect.
- Áp dụng tương tự cho Puppeteer legacy singleton.

---

### C9. Dependency audit đang fail

**Mức độ:** Medium security nhưng nên đưa vào nhóm đỏ vì security gate fail.  
**Trạng thái:** verified bằng `npm audit`.

Evidence:

- `hono@4.12.16`, advisory range `<=4.12.17`.
- `ws@8.20.0` qua `puppeteer-core@24.42.0`, advisory range `<8.20.1`.
- `npm audit --workspaces --omit=dev` fail với 2 moderate vulnerabilities.

**Context:** app hiện không thấy dùng Hono JSX SSR/cache middleware/JWT verify ở path nguy hiểm, nên risk thực tế có thể thấp hơn advisory. Nhưng fix có sẵn và audit đang fail.

**Fix đề xuất:**

- Update `hono >=4.12.18`.
- Update dependency chain để `ws >=8.20.1`.
- Chạy lại client tests, server tests, build, audit.

---

### C10. Secret artifacts còn nằm trong workspace local

**Mức độ:** High operational risk, không phải confirmed git leak.  
**Trạng thái:** verified bằng file existence/git ignore; không đọc nội dung secret.

Evidence:

- `.env.vps` tồn tại, không tracked, ignore bởi `.gitignore:4:.env.*`.
- `.env.local` tồn tại, không tracked, ignore bởi `.gitignore:4:.env.*`.
- `github_actions_deploy.pem` tồn tại, không tracked, ignore bởi `.gitignore:13:*.pem`.
- `VPS_deploy.md` tồn tại, không tracked, ignore bởi `.gitignore:31:VPS_deploy.md`.
- `git log --all --name-only -- .env.vps github_actions_deploy.pem VPS_deploy.md .env .env.local` không trả về file nào.

**Impact:** secret có thể bị backup/copy/log nhầm khi nằm trong repo folder.

**Fix đề xuất:**

- Chuyển private keys và env production ra ngoài repo workspace.
- Rotate secret nếu không chắc đã từng được copy/share.
- Giữ `.gitignore`, thêm checklist local secret hygiene.

---

## 🟡 Medium & Minor Issues

### M1. DB password có default yếu trong `docker-compose.yml`

Evidence:

- `docker-compose.yml:37`: `POSTGRES_PASSWORD: ${DB_PASSWORD:-newstamhv_secret}`.
- `docker-compose.yml:66`: `DATABASE_URL` cũng fallback `newstamhv_secret`.

Production có thể đã set `DB_PASSWORD`, nhưng source default vẫn yếu và dễ gây deploy nhầm.

**Fix:** đổi sang `${DB_PASSWORD:?DB_PASSWORD is required}` giống `ADMIN_TOKEN`.

---

### M2. CORS production đã restrict, nhưng compose default còn rộng

Evidence:

- `server/src/index.ts:36-40`: CORS lấy `process.env.CORS_ORIGIN`.
- `docker-compose.yml:72`: `CORS_ORIGIN: ${CORS_ORIGIN:-*}`.
- Live test với `Origin: https://example.invalid`: không có `access-control-allow-origin`.
- Live test với `Origin: https://synthnews.site`: có `access-control-allow-origin: https://synthnews.site`.

**Fix:** trong production, fail-fast nếu thiếu `CORS_ORIGIN`, hoặc default theo `PUBLIC_SITE_URL`.

---

### M3. SSRF guard chưa resolve DNS và chưa đủ IPv6/private ranges

Evidence:

- `server/src/lib/utils.ts:41-70`: block localhost/private IPv4 literal và `.local`.
- `server/src/lib/sourceResolver.ts:108-117`: block private hostname/literal trước detect.
- Guard chưa resolve DNS A/AAAA nên hostname public trỏ về private/link-local có thể lọt.

**Fix:** trước outbound fetch từ user-configured URL, resolve DNS và block private/reserved CIDR cả IPv4/IPv6; validate lại sau redirect/canonicalization.

---

### M4. Nginx thiếu CSP, Referrer-Policy, request size/rate-limit

Evidence:

- `nginx-synthnews.conf:4-8`: có HSTS, `X-Frame-Options`, `X-Content-Type-Options`, `X-XSS-Protection`.
- Live headers không có `Content-Security-Policy` và `Referrer-Policy`.
- Chưa thấy `client_max_body_size`, `limit_req`, `proxy_send_timeout`.

**Fix:** thêm CSP report-only trước, sau đó enforce; thêm `Referrer-Policy: strict-origin-when-cross-origin`; cân nhắc `client_max_body_size` và `limit_req`.

---

### M5. Worker generic ép gzip nhưng không passthrough `content-encoding`

Evidence:

- `fetch-proxy-worker.js:138`: set `Accept-Encoding: gzip`.
- `fetch-proxy-worker.js:155-160`: passthrough headers không có `content-encoding`.

**Impact:** client có thể nhận gzip bytes nhưng thiếu nhãn `Content-Encoding`, gây decode lỗi tùy upstream/runtime.

**Fix:** bỏ ép `Accept-Encoding` hoặc thêm `content-encoding` vào passthrough.

---

### M6. Workers cache lỗi như response tốt

Evidence:

- `reuters-proxy-worker.js:11`: `Cache-Control: public, max-age=120`.
- `voz-proxy-worker.js:12`: `Cache-Control: public, max-age=60`.
- Header được áp dụng qua `createHeaders` cho cả lỗi.

**Fix:** chỉ set cache public cho status `<400`; lỗi dùng `no-store` hoặc max-age rất ngắn.

---

### M7. Sidecar error/status mapping và timeout chưa đủ rõ

Evidence:

- `scrapling-sidecar/app/main.py:83-85`: mọi exception trả `status_code: 403`.
- `scrapling-sidecar/app/main.py:62-68`: dựa vào Scrapling timeout/thread executor; chưa có `asyncio.wait_for` cứng quanh call.
- `scrapling-sidecar/app/main.py:53`: health đọc `_fetch_semaphore._value`, thuộc tính private.

**Fix:** phân loại timeout/network/DNS/blocked thành 504/502/403 hợp lý; bọc `asyncio.wait_for`; maintain counter in-flight riêng thay vì đọc private field.

---

### M8. `useFetch` / `useFetchRaw` có race condition

Evidence:

- `client/src/hooks/useApi.ts:15-28` và `client/src/hooks/useApi.ts:37-50`: load async không AbortController, không staleness guard.

**Impact:** đổi filter/date/search nhanh có thể để response cũ ghi đè state mới.

**Fix:** dùng request id hoặc AbortController trong hook; pattern `SearchModal` đã có request id guard nên có thể tái dùng.

---

### M9. Render waterfall ở Home

Evidence:

- `Home.tsx` fetch dates, articles, sources, digests, tags qua nhiều hook phụ thuộc nhau.
- Local Playwright vẫn ổn, nhưng flow có nguy cơ latency cao khi API chậm.

**Fix:** song song hóa các request độc lập; tránh chờ dates nếu có cached/selected date hợp lệ.

---

### M10. Offline banner/persistent cache có dấu hiệu code chết

Evidence:

- `client/src/pages/Home.tsx:180`: đọc `raw?.offline || raw?.stale || datesRaw?.offline || datesRaw?.stale`.
- `client/src/services/persistentCache.ts:24-26`: `markPersistentData` mới gắn cờ.
- `rg markPersistentData client/src` chỉ thấy tests/mock, không thấy production call site.

**Fix:** nối persistent cache thật vào `request()` hoặc gỡ banner để tránh kỳ vọng sai.

---

### M11. Admin token lưu `localStorage` và dùng `window.prompt`

Evidence:

- `client/src/services/api.ts:20-56`: đọc/ghi `admin_token` trong `localStorage`, dùng `window.prompt`.
- Server có auth và rate limit tốt, nhưng frontend auth UX còn yếu.

**Fix:** login panel trong Admin route, explicit logout, session expiry; nếu nâng cấp lớn hơn thì dùng HttpOnly Secure SameSite cookie session.

---

### M12. Multi-step DB mutations chưa luôn dùng transaction

Evidence:

- `server/src/db/index.ts:48-61`: đã có `withTransaction`.
- `server/src/routes/articles.ts:322-330`: batch delete làm 2 query.
- `server/src/routes/articles.ts:362-372`: single delete làm 2 query.
- `server/src/routes/articles.ts:408-448`: manual cluster làm 2 update.

**Fix:** bọc bằng `withTransaction` hoặc rely vào `ON DELETE CASCADE` đúng cách.

---

### M13. Hosted-fetch budget không atomic và đếm attempt trước success

Evidence:

- `server/src/services/fetchers/hosted-fetch.ts:194`: `provider.used++` trước khi fetch.

**Impact:** provider timeout/fail vẫn ăn budget; nhiều caller đồng thời có thể race qua cap.

**Fix:** tăng `used` sau success hoặc track attempt/success riêng; nếu cần atomic cross-process thì chuyển vào DB/app_settings.

---

### M14. Scrape tuần tự, nguồn chậm có thể kéo cả batch

Evidence:

- VOZ timeout có thể tới 600s trong `server/src/jobs/scheduler.ts`.
- Scrape job xử lý source theo batch tuần tự.

**Fix:** xử lý song song có giới hạn, ví dụ concurrency 3-4, nhưng vẫn giữ rate/backoff theo source.

---

### M15. Query performance nên được đo bằng `EXPLAIN ANALYZE`

Evidence:

- Public feed có `total=20368` trên production.
- Filters theo `summary_status`, `parent_article_id`, local date expression, tags.
- Migrations hiện có index cơ bản: `idx_articles_source_published`, `idx_articles_summary_status`, `idx_articles_content_hash`.

**Fix:** đo `EXPLAIN ANALYZE` trước khi thêm:

- partial index cho public done/leader/latest;
- GIN index cho `tags`;
- generated `local_date_vi` nếu date filter là workflow chính.

---

### M16. Maintainability hotspots và `any`

Evidence:

- `client/src/pages/Home.tsx`: 751 lines, nhiều state/effects.
- `client/src/styles/home.css`: 1566 lines.
- `server/src/services/fetchers/forum-fetchers.ts`: 819 lines.
- `server/src/services/fetchers/rss-fetcher.ts`: 652 lines.
- Tổng `rg "\bany\b" client/src server/src scrapling-sidecar/app`: 323 matching lines.
- `client/src/services/api.ts:88-216`: phần lớn endpoint là `request<any>`.

**Fix:** shared API types, tách `Home.tsx` thành hooks/components, tách fetchers Reddit/VOZ/RSS, giảm `any` theo module.

---

### M17. Frontend accessibility/modals cần cải thiện

Evidence:

- `ArticleDetail.tsx` có `role="dialog"` nhưng chưa thấy focus trap/return focus.
- Search modal/settings sheet cũng nên kiểm focus trap.

**Fix:** focus trap nhẹ cho modal, return focus về trigger, đảm bảo Escape/Tab behavior nhất quán.

---

## 🟢 Điểm đang làm đúng

- SQL query hầu hết parameterized, không thấy SQL injection obvious.
- `ADMIN_TOKEN` production fail-fast nếu yếu: `server/src/lib/auth.ts:19-23`.
- Token compare dùng `crypto.timingSafeEqual`: `server/src/lib/auth.ts:31-33`.
- Write/admin rate limit có trong `server/src/lib/rateLimit.ts`.
- Migration runner dùng transaction per file: `server/src/db/migrate.ts:41-54`.
- Queue claim dùng `FOR UPDATE SKIP LOCKED`:
  - summaries: `server/src/services/summarizer.ts:84-109`;
  - article fetch jobs: `server/src/services/article-fetch-queue.ts:73-103`.
- `exec()` shell string risk cũ đã giảm bằng `execFile`: `server/src/services/fetchers/http-utils.ts:49-73`.
- Generic Worker proxy có token và domain allowlist: `fetch-proxy-worker.js:79-85`, `fetch-proxy-worker.js:111-116`.
- URL guard đã block private literal cơ bản: `server/src/lib/utils.ts:41-70`.
- Gemini output token floor `>=16384`: `server/src/services/ai-client.ts:34-42`.
- AI fallback/retry provider có logic: `server/src/services/ai-client.ts:172-204`.
- Prompt injection guard trong summarizer prompt: `server/src/services/summarizer.ts:298`, `server/src/services/summarizer.ts:365`.
- React client không thấy `dangerouslySetInnerHTML`.
- `react-markdown` không bật `rehype-raw`, giảm XSS risk từ raw HTML.
- Production UI Home render tốt desktop/mobile, không horizontal overflow trong audit.
- Nginx có HSTS, frame-options, nosniff.
- Docker DB/app port bind `127.0.0.1`, không mở trực tiếp ra public.
- Scrapling có `init: true`, resource limit, pids cap trong compose.
- Deploy workflow có API health, articles smoke, và Puppeteer smoke thật.

---

## 🗺️ Action Plan hợp nhất

### P0 - Sửa ngay trong 1 buổi

1. **Fix dependency audit**
   - Update `hono >=4.12.18`.
   - Update dependency chain để `ws >=8.20.1`.
   - Verify: client tests, server tests, build, audit.

2. **Bắt buộc `DB_PASSWORD`**
   - Đổi `docker-compose.yml` từ `${DB_PASSWORD:-newstamhv_secret}` sang `${DB_PASSWORD:?DB_PASSWORD is required}` ở cả `POSTGRES_PASSWORD` và `DATABASE_URL`.
   - Kiểm VPS đã set `DB_PASSWORD` trước khi deploy.

3. **Chặn future-dated public feed**
   - Thêm tolerance policy ở ingest hoặc public filter.
   - Thêm tests.
   - Clean/backfill rows future-dated hiện có.

4. **Protect operational GET**
   - `/api/articles/fetch-jobs` admin-only.
   - Tách `/api/sources/public` cho reader.

5. **Fix advisory lock leak**
   - Nếu unlock fail thì `client.release(true)`.
   - Log lỗi unlock riêng.

6. **Fix browser singleton mutex**
   - Dùng promise-cache cho Playwright/Puppeteer singleton.
   - Reset promise khi launch fail/disconnect.

7. **Add token cho specialized Workers**
   - `reddit`, `reuters`, `voz` Workers check `PROXY_TOKEN`.
   - Siết CORS.

### P1 - 1 đến 2 ngày

8. **Harden Scrapling sidecar**
   - Shared `X-Sidecar-Token`.
   - URL validation độc lập trong Python.
   - Error/status mapping rõ hơn.

9. **Container hardening**
   - Non-root user cho app/sidecar.
   - Writable dirs rõ ràng.
   - Thử bỏ `--no-sandbox`; nếu chưa bỏ được thì thêm `cap_drop/security_opt`.

10. **Secret hygiene local**
    - Di chuyển `.env.vps`, `.env.local`, `.pem`, deployment doc có secret ra ngoài repo folder.
    - Rotate secret nếu cần.

11. **Worker reliability fixes**
    - `fetch-proxy-worker`: bỏ ép gzip hoặc passthrough `content-encoding`.
    - `voz/reuters`: chỉ cache 2xx; lỗi dùng `no-store`.

12. **Frontend race guard**
    - Thêm request id/AbortController vào `useFetch` và `useFetchRaw`.
    - Bỏ `window.prompt` dần bằng login panel.

### P2 - 1 tuần

13. **Encrypt AI provider secrets at rest**
    - Envelope encryption.
    - Migration existing keys.
    - Tests đảm bảo API không trả plaintext.

14. **Schema validation route boundary**
    - Dùng `zod` hoặc validator cho `sources`, `ai-providers`, `settings`, `blocklist`, batch actions.
    - Max length và JSON size.

15. **Transactions cho multi-step mutations**
    - Article delete, batch delete, cluster/uncluster/rescrape, digest generation.

16. **SSRF DNS hardening**
    - Resolve A/AAAA và block private/reserved CIDR.
    - Validate sau redirect.

17. **Nginx/security headers**
    - CSP report-only, sau đó enforce.
    - `Referrer-Policy`.
    - `client_max_body_size`, `limit_req`, `proxy_send_timeout`.

### P3 - 2 đến 4 tuần

18. **Refactor maintainability**
    - Tách `Home.tsx`, `home.css`, `forum-fetchers.ts`, `rss-fetcher.ts`.
    - Shared API types cho `Article`, `Source`, `Digest`, `FetchJob`, `AiProvider`.
    - Giảm `any` theo module.

19. **DB performance**
    - `EXPLAIN ANALYZE` public feed/date/tag queries.
    - Thêm index có bằng chứng: partial done/leader/latest, GIN tags, generated local date nếu cần.

20. **Observability**
    - Alert future-dated count > 0.
    - Metrics scrape/fetch/AI by source/provider.
    - Alert browser process count/PID growth.

21. **Admin UX/a11y**
    - Login panel, logout, token expiry.
    - Focus trap/return focus cho modals.

---

## Ghi chú về severity

- Claude/Kiro đúng khi bắt `jobLock`, browser singleton, Worker gzip/cache, `useFetch` race, offline banner dead code. Các finding này nên đưa vào plan sửa thật.
- Một số mục Claude gọi Critical nên hạ còn High/Medium vì cần điều kiện phụ: sidecar không publish port, advisory lock leak cần unlock failure, DB default cần production thiếu env.
- Một số mục Codex đưa High nên giữ nhưng cần phân biệt operational risk: local secret artifacts chưa bị commit, nhưng vẫn nên dọn ngay.
- Bản hợp nhất này ưu tiên sửa những lỗi có tỷ lệ impact/công sức tốt nhất trước: dependency audit, DB password default, future-date feed, operational GET, job lock, browser mutex, Worker auth.


# Plan khắc phục Audit SynthNews 2026-06-02

> Bản kế hoạch này được lập để review trước khi triển khai. Nội dung dựa trên `BAO_CAO_AUDIT_HOP_NHAT_SYNTHNEWS_2026-06-02.md` và chỉ mô tả lộ trình thực hiện, chưa thay đổi code vận hành.

## 1. Mục tiêu

Khắc phục các finding quan trọng trong audit hợp nhất theo thứ tự ưu tiên: giảm rủi ro bảo mật trước, sửa lỗi data correctness và reliability tiếp theo, sau đó mới xử lý hardening dài hạn, hiệu năng và maintainability.

Mục tiêu sau khi hoàn tất:

- Public reader API không còn lộ dữ liệu vận hành nội bộ.
- Public feed không bị bài future-dated chiếm thứ tự hoặc gây empty-state sai.
- Dependency audit sạch hoặc còn advisory đã có lý do chấp nhận rõ ràng.
- Cron/job lock và browser singleton không có nguy cơ leak lock/process trong tình huống lỗi cạnh tranh.
- Workers và Scrapling sidecar có auth nội bộ tối thiểu.
- Docker runtime giảm quyền root/sandbox risk tối đa trong điều kiện scraper/browser vẫn chạy ổn.
- Có test và smoke checklist đủ để deploy production theo local-first workflow.

## 2. Nguyên tắc triển khai

- Làm trên branch riêng, đề xuất: `codex/audit-remediation-2026-06-02`.
- Luôn verify local trước khi push/deploy:
  - `npm test --workspace=client`
  - `npm test --workspace=server`
  - `npm run build`
  - `npm audit --workspaces --omit=dev`
- Không in, echo, copy, commit hoặc paste secret/token/key vào log, report, commit message.
- Không stage/commit các file local-only hoặc secret artifacts như `.env.*`, `*.pem`, `VPS_deploy.md`.
- Ưu tiên thay đổi nhỏ, có checkpoint rõ sau từng phase. Với phase có nguy cơ ảnh hưởng production, deploy sau khi local và smoke test đã xanh.
- Không redesign UI lớn trong đợt audit fix này; nếu đụng frontend, giữ phong cách SynthNews hiện tại: nghiêm túc, sạch, dễ đọc.

## 3. Phase 0 - Chuẩn bị và baseline

### Việc cần làm

1. Tạo branch triển khai:
   ```powershell
   git switch -c codex/audit-remediation-2026-06-02
   ```

2. Kiểm tra working tree:
   ```powershell
   git status --short
   ```

   Ghi chú hiện tại có thể có các report audit untracked:
   - `AUDIT_TONGHOP_newstamhv_2026-06-02.md`
   - `FULL_AUDIT_CODE_REVIEW_SYNTHNEWS_2026-06-02.md`
   - `BAO_CAO_AUDIT_HOP_NHAT_SYNTHNEWS_2026-06-02.md`
   - `PLAN_KHAC_PHUC_AUDIT_SYNTHNEWS_2026-06-02.md`

3. Chạy baseline trước khi sửa:
   ```powershell
   npm test --workspace=client
   npm test --workspace=server
   npm run build
   npm audit --workspaces --omit=dev
   ```

4. Kiểm tra VPS đã có biến môi trường bắt buộc trước khi deploy Compose hardening:
   - `DB_PASSWORD`
   - `ADMIN_TOKEN`
   - `CORS_ORIGIN`
   - `PUBLIC_SITE_URL`

   Không in giá trị secret ra terminal. Chỉ xác nhận có/không có.

### Tiêu chí hoàn tất

- Có baseline test/build/audit trước khi sửa.
- Biết rõ advisory nào đang tồn tại.
- Biết chắc deploy Compose sẽ không fail vì thiếu biến môi trường bắt buộc.

## 4. Phase 1 - P0 Security và Data Correctness

### 4.1. Fix dependency audit

**Mục tiêu:** `npm audit --workspaces --omit=dev` không còn fail vì advisory đã có bản vá.

**Thay đổi dự kiến:**

- Cập nhật `hono` lên `>=4.12.18`.
- Cập nhật dependency chain để `ws >=8.20.1`, nhiều khả năng qua `puppeteer-core` hoặc lockfile.
- File có thể thay đổi:
  - `server/package.json`
  - `package-lock.json`

**Verify:**

```powershell
npm install
npm audit --workspaces --omit=dev
npm test --workspace=server
npm run build
```

### 4.2. Bắt buộc `DB_PASSWORD` và siết default CORS

**Mục tiêu:** tránh deploy nhầm với password mặc định yếu hoặc CORS `*`.

**Thay đổi dự kiến trong `docker-compose.yml`:**

- Đổi:
  - `POSTGRES_PASSWORD: ${DB_PASSWORD:-newstamhv_secret}`
  - `DATABASE_URL: postgresql://newstamhv:${DB_PASSWORD:-newstamhv_secret}@db:5432/newstamhv`
  - `CORS_ORIGIN: ${CORS_ORIGIN:-*}`
- Thành dạng fail-fast:
  - `POSTGRES_PASSWORD: ${DB_PASSWORD:?DB_PASSWORD is required}`
  - `DATABASE_URL: postgresql://newstamhv:${DB_PASSWORD:?DB_PASSWORD is required}@db:5432/newstamhv`
  - `CORS_ORIGIN: ${CORS_ORIGIN:?CORS_ORIGIN is required}`

**Verify:**

```powershell
docker compose config
```

Trên VPS, chỉ deploy sau khi xác nhận các biến đã được set.

### 4.3. Protect operational GET endpoints

**Mục tiêu:** reader public vẫn hoạt động, nhưng dữ liệu vận hành chi tiết không còn public.

**Thay đổi dự kiến:**

- Trong `server/src/lib/auth.ts`:
  - Bảo vệ GET `/api/sources`.
  - Bảo vệ GET `/api/articles/fetch-jobs`.
  - Giữ public `/api/health/live`.
  - Giữ public reader endpoints cần thiết như `/api/articles`, `/api/articles/dates`, `/api/articles/tags`, `/api/articles/search`.

- Trong `server/src/routes/sources.ts`:
  - Thêm route `GET /api/sources/public`.
  - Route này phải đặt trước `GET /api/sources/:id` để không bị Hono match `public` thành `id`.
  - Chỉ trả field an toàn:
    - `id`
    - `name`
    - `type`
    - `is_enabled`
    - `feed_category`

- Trong client:
  - Reader page dùng `/api/sources/public`.
  - Admin vẫn dùng `/api/sources` có token để xem full detail.

**Test cần thêm/cập nhật:**

- `server/tests/auth-policy.test.mjs`:
  - `GET /api/sources` yêu cầu admin token.
  - `GET /api/sources/public` không yêu cầu token.
  - `GET /api/articles/fetch-jobs` yêu cầu admin token.
  - `GET /api/articles` vẫn public.

**Production acceptance:**

```text
GET /api/sources without token -> 401
GET /api/articles/fetch-jobs without token -> 401
GET /api/sources/public without token -> 200
/api/sources/public không có parser_config, last_error_message, next_run_at
```

### 4.4. Chặn future-dated public feed

**Mục tiêu:** bài có ngày xuất bản tương lai không phá thứ tự feed và không gây empty-state sai trên Home.

**Policy mặc định:**

- Tolerance: `2 hours`.
- Reader/public feed ẩn article có `COALESCE(published_at, created_at) > NOW() + INTERVAL '2 hours'`.
- Admin vẫn có đường xem bài lỗi để dọn hoặc debug.

**Thay đổi dự kiến:**

- Trong `server/src/lib/articleFilters.ts`:
  - Thêm public freshness clause vào list/search/date/tag filters.
  - Không áp dụng clause khi query là admin/ops mode, ví dụ có `status`, `qualityIssue`, hoặc option explicit để include future.

- Trong `server/src/services/fetchers/article-writer.ts`:
  - Khi `publishedAt` vượt `now + 2h`, không lưu timestamp tương lai vào `published_at`.
  - Giải pháp ưu tiên: set `published_at` về `new Date().toISOString()` để bài vẫn có vị trí hợp lý trong feed.
  - Nếu metadata hiện có thể lưu object, ghi warning như `future_published_at_dropped` và raw value để debug.

- Dọn dữ liệu hiện có:
  - Trước khi chạy update, backup DB hoặc snapshot volume.
  - Update các row future-dated hiện tại về `created_at` hoặc `NOW()`, tùy row nào hợp lý hơn.

**Test cần thêm/cập nhật:**

- `server/tests/article-filters.test.mjs`:
  - Public filter có future-date guard.
  - Admin/status filter không bị ẩn dữ liệu cần review.
- `server/tests/date-utils.test.mjs` hoặc test writer:
  - Future date vượt tolerance không được lưu nguyên vào public `published_at`.

**Production acceptance:**

```text
GET /api/articles?limit=5&status=done không còn bài future-dated đứng đầu public feed
GET /api/articles/dates không còn ngày tương lai cho reader
Home không empty-state khi API có bài hợp lệ
```

## 5. Phase 2 - P0 Reliability và Worker Hardening

### 5.1. Fix advisory lock leak

**Mục tiêu:** nếu unlock advisory lock lỗi, connection không quay lại pool trong trạng thái giữ lock.

**Thay đổi dự kiến trong `server/src/lib/jobLock.ts`:**

- Tách trạng thái `locked`.
- Trong `finally` sau `fn()`, gọi unlock trong `try/catch`.
- Nếu unlock fail:
  - log lỗi rõ `Failed to release advisory lock`.
  - `client.release(true)` để destroy connection.
- Nếu unlock ok:
  - `client.release()`.

**Test đề xuất:**

- Nếu test hiện tại dễ mock pool client, thêm test unlock failure gọi `release(true)`.
- Nếu khó mock trong node test hiện tại, ít nhất build/typecheck và review logic thật kỹ.

### 5.2. Fix browser singleton mutex/promise-cache

**Mục tiêu:** nhiều request đồng thời không launch nhiều Chromium rồi ghi đè singleton, tránh leak process/RAM.

**Thay đổi dự kiến trong `server/src/services/fetchers/http-utils.ts`:**

- Với Puppeteer:
  - Thêm `pupBrowserPromise`.
  - Nếu browser connected, return browser.
  - Nếu promise đang launch, await promise.
  - Nếu launch fail, reset promise và throw.
  - Khi browser disconnect, reset instance/promise.

- Với Playwright:
  - Thêm `pwBrowserPromise`.
  - Áp dụng cùng pattern.

**Verify:**

```powershell
npm test --workspace=server
npm run build
```

Nếu có local server, gọi health/browser smoke để đảm bảo browser vẫn launch được.

### 5.3. Harden Cloudflare Workers

**Mục tiêu:** Workers không còn là proxy public không token; lỗi không bị cache như response tốt.

**Thay đổi dự kiến:**

- Trong `voz-proxy-worker.js`, `reddit-proxy-worker.js`, `reuters-proxy-worker.js`:
  - Check `env.PROXY_TOKEN`.
  - Yêu cầu header `X-Proxy-Token`.
  - Health endpoint có thể public hoặc cũng yêu cầu token; mặc định giữ health public chỉ trả `{ ok: true }`.
  - CORS chỉ cho `https://synthnews.site` hoặc bỏ nếu chỉ app server gọi.
  - Error response dùng `Cache-Control: no-store`.
  - Response thành công `<400` mới dùng public cache.

- Trong `fetch-proxy-worker.js`:
  - Bỏ `Accept-Encoding: gzip` ép cứng, hoặc passthrough `content-encoding`.
  - Ưu tiên bỏ ép gzip để giảm lỗi decode.

**Verify:**

- Local syntax review/build nếu có tool.
- Sau deploy Worker:
  - Request thiếu `X-Proxy-Token` trả 401.
  - Request có token vẫn fetch được domain allowlisted.
  - Error response không có public cache dài.

## 6. Phase 3 - P1 Runtime Hardening

### 6.1. Harden Scrapling sidecar

**Mục tiêu:** sidecar không còn nhận request nội bộ không auth và tự có guard URL.

**Thay đổi dự kiến:**

- Trong `docker-compose.yml`:
  - Thêm env token chung cho app và sidecar, ví dụ `SCRAPLING_SERVICE_TOKEN`.
  - Fail-fast nếu production thiếu token.

- Trong `server/src/services/fetchers/scrapling-fetch.ts`:
  - Gửi header `X-Sidecar-Token: <token>`.
  - Nếu thiếu token ở production, fail-fast.

- Trong `scrapling-sidecar/app/main.py`:
  - Validate `X-Sidecar-Token`.
  - Validate URL:
    - chỉ `http`/`https`;
    - block localhost;
    - block private IPv4;
    - block IPv6 loopback/link-local/private;
    - block metadata IP như `169.254.169.254`.
  - Thêm timeout cứng quanh executor bằng `asyncio.wait_for`.
  - Phân loại lỗi:
    - timeout -> 504;
    - network/DNS -> 502;
    - blocked/anti-bot -> 403;
    - validation/auth -> 400/401.
  - Không đọc private `_fetch_semaphore._value`; dùng counter in-flight riêng.

**Verify:**

- Build sidecar image.
- Health OK.
- `/fetch` thiếu token -> 401.
- `/fetch` với localhost/private URL -> 400/403.
- `/fetch` URL public hợp lệ với token -> 200 hoặc upstream-specific response.

### 6.2. Container hardening

**Mục tiêu:** giảm blast radius nếu browser/scraper bị exploit.

**Thay đổi dự kiến:**

- Trong `Dockerfile`:
  - Tạo non-root user/group.
  - Chown `/app` và `/tmp/img-cache`.
  - Chạy `USER` non-root ở production stage.

- Trong `scrapling-sidecar/Dockerfile`:
  - Tạo non-root user/group.
  - Chown browser/cache dirs cần thiết.
  - Chạy `USER` non-root.

- Trong `docker-compose.yml`:
  - Thêm `cap_drop: ["ALL"]` nếu không phá Chromium/Camoufox.
  - Thêm `security_opt: ["no-new-privileges:true"]`.
  - Chỉ mở writable dirs cần thiết.

- Với `--no-sandbox`:
  - Thử bỏ sau khi container non-root.
  - Nếu browser fail, giữ lại tạm thời nhưng phải document lý do và bù bằng container hardening.

**Verify:**

```powershell
docker compose build
docker compose up -d
docker compose exec app id
docker compose exec scrapling id
```

Acceptance: app và scrapling không còn `uid=0(root)` nếu không có blocker kỹ thuật.

### 6.3. Secret hygiene local

**Mục tiêu:** giảm nguy cơ copy/backup nhầm secret nằm trong repo folder.

**Việc cần làm:**

- Di chuyển các file secret/local-only ra ngoài `D:\Antigravity\newstamhv`:
  - `.env.vps`
  - `.env.local`
  - `github_actions_deploy.pem`
  - tài liệu deploy nếu chứa secret thật.
- Giữ `.env.example` và `.env.local.example` không chứa secret thật.
- Nếu không chắc secret từng bị chia sẻ/copy, rotate:
  - `ADMIN_TOKEN`
  - deploy SSH key;
  - Worker tokens;
  - provider keys quan trọng.

## 7. Phase 4 - P2/P3 Cải tiến dài hạn

### 7.1. Encrypt AI provider secrets at rest

**Mục tiêu:** DB dump/backup không lộ plaintext provider keys.

**Thay đổi dự kiến:**

- Thêm encryption helper dùng master key từ env.
- Mã hoá `api_key` và `service_account_json` trước khi ghi DB.
- Giải mã tại service layer khi gọi provider.
- Migration dữ liệu hiện có:
  - backup DB;
  - migrate plaintext -> encrypted;
  - verify API list/detail vẫn mask secret;
  - rotate provider key sau migration nếu cần.

### 7.2. Validation boundary cho API routes

**Mục tiêu:** input validation nhất quán, giảm `any`, giảm lỗi payload lạ.

**Thay đổi dự kiến:**

- Dùng `zod` hoặc validator tương đương cho:
  - sources;
  - ai-providers;
  - settings;
  - blocklist;
  - article batch actions;
  - fetch job actions.
- Giới hạn length, enum, JSON size, parser_config shape.

### 7.3. Transactions cho multi-step DB mutations

**Mục tiêu:** không có trạng thái DB nửa chừng khi một query trong chuỗi lỗi.

**Thay đổi dự kiến trong `server/src/routes/articles.ts`:**

- Bọc bằng `withTransaction` cho:
  - batch delete article;
  - single delete article;
  - cluster/uncluster;
  - rescrape/reset nhiều bước nếu có.

### 7.4. SSRF DNS hardening

**Mục tiêu:** hostname public trỏ về private/link-local không lọt outbound fetch.

**Thay đổi dự kiến:**

- Resolve A/AAAA trước outbound fetch với source/user-configured URL.
- Block private/reserved CIDR IPv4 và IPv6.
- Validate lại sau redirect/canonical URL nếu fetch layer follow redirect.
- Áp dụng nhất quán cho Node fetcher và sidecar.

### 7.5. Frontend race guard và admin UX

**Mục tiêu:** response cũ không ghi đè state mới; admin auth UX đỡ mong manh.

**Thay đổi dự kiến:**

- Trong `client/src/hooks/useApi.ts`:
  - thêm request id hoặc AbortController cho `useFetch` và `useFetchRaw`;
  - only latest request được set state.
- Trong admin:
  - thay `window.prompt` bằng login panel trong Admin route;
  - có explicit logout;
  - hiển thị auth error rõ ràng.

### 7.6. Performance, observability và maintainability

**DB performance:**

- Chạy `EXPLAIN ANALYZE` cho:
  - public feed latest;
  - public feed hot;
  - dates;
  - tags;
  - search.
- Chỉ thêm index khi có bằng chứng:
  - partial index cho done/leader/latest;
  - GIN index cho tags nếu query tag chậm;
  - generated local date nếu date query chậm.

**Observability:**

- Alert khi future-dated count > 0.
- Theo dõi browser process count/PID growth.
- Metrics scrape/fetch/AI theo source/provider.
- Log unlock failure và browser launch failure có severity rõ.

**Maintainability:**

- Tách dần các hotspot:
  - `Home.tsx`;
  - `home.css`;
  - `forum-fetchers.ts`;
  - `rss-fetcher.ts`.
- Tạo shared API types cho:
  - `Article`;
  - `Source`;
  - `Digest`;
  - `FetchJob`;
  - `AiProvider`.
- Giảm `any` theo module, ưu tiên route boundary và client API service.

## 8. Test plan tổng hợp

### Test bắt buộc trước mỗi phase merge

```powershell
npm test --workspace=client
npm test --workspace=server
npm run build
```

### Security gate

```powershell
npm audit --workspaces --omit=dev
```

Kỳ vọng: pass. Nếu fail vì advisory chưa có bản vá thực tế, ghi rõ package, path, exploitability trong PR/commit note.

### Docker/local production smoke

```powershell
docker compose config
docker compose build
docker compose up -d
docker compose ps
```

Kiểm:

- app healthy;
- scrapling healthy;
- db healthy;
- app và scrapling không chạy root nếu phase container hardening đã triển khai.

### API smoke local/production

```text
GET /api/health/live -> 200
GET /api/sources -> 401 nếu không token
GET /api/sources/public -> 200
GET /api/articles/fetch-jobs?limit=1 -> 401 nếu không token
GET /api/articles?limit=5&status=done -> không có bài future-dated đứng đầu
```

### UI smoke

- Desktop: `/`, `/sources`, `/admin`.
- Mobile width khoảng 390px: `/`, `/sources`, `/admin`.
- Không horizontal overflow.
- Home không empty-state khi API có article hợp lệ.
- Admin hiển thị trạng thái auth rõ ràng.

## 9. Production rollout checklist

1. Backup DB hoặc snapshot volume trước các bước migration/backfill.
2. Verify VPS env có đủ biến bắt buộc, không in secret value.
3. Push branch/merge theo flow đã chọn.
4. Đợi GitHub Actions deploy xong.
5. Kiểm commit trên VPS trùng commit đã push.
6. Kiểm container health:
   ```bash
   docker compose ps
   ```
7. Kiểm API smoke production:
   - `https://synthnews.site/api/health/live`
   - `/api/sources/public`
   - `/api/articles?limit=5&status=done`
8. Kiểm endpoint protected không token trả 401:
   - `/api/sources`
   - `/api/articles/fetch-jobs?limit=1`
9. Kiểm UI production desktop/mobile.
10. Theo dõi logs 15-30 phút:
    - app crash;
    - browser launch failure;
    - scrapling 401/timeout bất thường;
    - DB migration/backfill error.

## 10. Rollback plan

- Nếu deploy fail vì env bắt buộc thiếu: set env trên VPS rồi deploy lại, không revert code ngay.
- Nếu public reader hỏng vì `/api/sources/public`: rollback client endpoint hoặc tạm public-safe route alias.
- Nếu scraper/browser fail sau non-root/no-sandbox: giữ non-root nếu có thể, restore `--no-sandbox` tạm thời và bù bằng `cap_drop`/`no-new-privileges`.
- Nếu future-date filter ẩn quá nhiều bài: tăng tolerance tạm thời bằng constant/env, sau đó điều tra source parser.
- Nếu Worker token làm scraper mất đường proxy: kiểm env token ở Worker và app server, sau đó mới rollback Worker auth.

## 11. Assumptions đã chốt

- File plan đặt ở root repo để dễ đọc cạnh các báo cáo audit.
- Phase 1 và Phase 2 nên làm trước vì tỷ lệ giảm rủi ro/công sức tốt nhất.
- Encryption AI secrets, schema validation toàn diện, SSRF DNS hardening và refactor lớn để sang Phase 4 vì blast radius cao hơn.
- Tolerance future-date mặc định là `2 hours`.
- Production deploy vẫn theo workflow local-first rồi GitHub Actions/Docker Compose trên Oracle VPS.
- Không commit secret artifacts và không tự ý stage/commit nếu anh chưa yêu cầu.

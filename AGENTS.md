# SynthNews — Agent Instructions

## Quick Access (dùng hàng ngày)

**SSH vào VPS:**
```bash
ssh -i "C:\Users\Ha Tam\Downloads\ssh-key-2026-04-20_tamhvt.key" ubuntu@158.178.239.119
```

**Query DB trực tiếp:**
```bash
cd ~/newstamhv && docker compose exec -T db psql -U newstamhv -d newstamhv -c "..."
```

**Git remote:** `https://github.com/tam1012/SynthNews.git` (branch `main`)

**Memory files (chi tiết project):** `C:\Users\Ha Tam\.claude\projects\d--Antigravity\memory\`

**Quy tắc ghi nhớ:** Trong quá trình hỗ trợ dự án này, nếu phát hiện thông tin quan trọng
(pattern lỗi mới, ngưỡng/tham số mới, quyết định kiến trúc, bài học từ sự cố...),
**tự động lưu vào memory** (thư mục trên) hoặc tạo file ghi nhớ mới. Không cần hỏi Anh trước.
Nếu phát hiện thông tin trong file này đã lỗi thời hoặc không chính xác với thực tế,
**tự động sửa lại cho đúng.**

## Deployment

**QUAN TRỌNG: Dự án này dùng GitHub Actions tự động deploy.**

Khi push lên branch `main`, workflow `.github/workflows/deploy.yml` sẽ:
1. SSH vào Oracle VPS (`158.178.239.119`)
2. `git pull` → `docker compose up -d --build`
3. Chạy health check + smoke test tự động

**KHÔNG cần deploy thủ công trên VPS sau khi push.** Chỉ cần commit, push,
rồi GitHub Actions lo phần còn lại. Nếu cần thao tác DB thủ công (reset
trạng thái bài viết, sửa dữ liệu...) thì mới SSH vào VPS.

**Quy trình làm việc khuyến nghị:**
1. Sửa code local → test tại `https://synthnews.local`
2. Commit + push → GitHub Actions tự deploy
3. Verify VPS đã sync: `ssh ... "cd ~/newstamhv && git log --oneline -1"`
4. Không commit file local-only (scripts, .env.local, docs cấu hình local)

## Project Structure

- `server/` — Backend Node.js (Hono framework, TypeScript, PostgreSQL)
- `client/` — Frontend (Vite + vanilla JS)
- `scrapling-sidecar/` — Python sidecar cho browser-based scraping
- `scripts/` — Utility scripts (backup, restart, cookie refresh)

## VPS Info

- Host: Oracle Singapore ARM (`158.178.239.119`)
- Project dir: `/home/ubuntu/newstamhv`
- Containers: `newstamhv-app`, `newstamhv-db` (Postgres 16), `newstamhv-scrapling`
- DB port mapping: `127.0.0.1:5433 → 5432` (container)
- App port mapping: `127.0.0.1:3001 → 3000` (container)
- Public URL: https://synthnews.site
- Health check: `curl -s http://127.0.0.1:3001/api/health`

## Database Quick Reference

**Kết nối:** DB hostname là `db` trong Docker network, `127.0.0.1:5433` từ host VPS.
Khi chạy script Node trực tiếp trên host VPS, PHẢI set đè `DATABASE_URL` qua port localhost.

**Các bảng chính:**

| Bảng | Mục đích |
|------|----------|
| `articles` | Bài viết đã scrape (status: pending→processing→done/failed/skipped) |
| `sources` | Nguồn tin (RSS, web, Reddit, VOZ...) |
| `scrape_logs` | Lịch sử mỗi lần scrape (items_found, items_inserted, error) |
| `article_fetch_jobs` | Job fetch nội dung bài (status: discovered→fetching→done/failed) |
| `ai_providers` | Cấu hình AI provider (model, max_tokens, extra_config) |
| `app_settings` | Cấu hình runtime (prompt config, routing model) |
| `digests` / `digest_items` | Bản tin tổng hợp hàng ngày |

**Các query thường dùng khi debug:**

```sql
-- Bài bị failed + lý do
SELECT id, url, title, summary_status, retry_count, last_summary_error
FROM articles WHERE summary_status = 'failed' ORDER BY created_at DESC LIMIT 20;

-- Nguồn scrape bị lỗi
SELECT s.name, sl.started_at, sl.status, sl.items_found, sl.items_inserted,
       substring(sl.error_message, 1, 300) as err
FROM scrape_logs sl JOIN sources s ON s.id = sl.source_id
WHERE sl.items_inserted = 0 AND sl.items_found > 0
  AND sl.started_at > NOW() - INTERVAL '24 hours'
ORDER BY s.name, sl.started_at DESC;

-- Tổng quan số lượng bài theo trạng thái
SELECT summary_status, COUNT(*) FROM articles GROUP BY summary_status;

-- Fetch jobs đang pending/failed
SELECT j.status, COUNT(*) FROM article_fetch_jobs j GROUP BY j.status;

-- Reset bài về pending để thử lại
UPDATE articles SET summary_status = 'pending', retry_count = 0,
  last_summary_error = NULL, summary_text = NULL, tldr = NULL,
  summary_short = NULL, hot_score = NULL, tags = '{}'::TEXT[]
WHERE id = 'art_xxx';
```

## AI Summary Pipeline

### Luồng xử lý chính

```
Scrape → pending → processing → done/failed/skipped
```

Các job cron:
1. **Discover/Scrape** — Tìm bài mới từ RSS/Web/Reddit/VOZ
2. **Fetch** — Tải nội dung text đầy đủ
3. **Summarize** — AI tóm tắt + dịch sang tiếng Việt
4. **Digest** — Gom bài `done` trong 24h thành bản tin tổng hợp

### Pipeline tóm tắt chi tiết

Mỗi bài khi được summarize trải qua các tầng:

```
1. Kiểm tra content đủ dài? (<500 chars non-forum → skip)
2. Kiểm tra promo/spam? (từ khóa + AI classify → skip)
3. Gọi AI lần đầu (news prompt hoặc forum prompt)
4. Parse output → kiểm tra isUsable
5. Nếu KHÔNG usable → repair (gửi lại output cho AI định dạng JSON)
6. Nếu repair vẫn fail → assertion error → article = failed
7. Nếu AI từ chối (safety) → safe fallback prompt
```

### Các ngưỡng quan trọng

| Ngưỡng | Vị trí | Ý nghĩa |
|--------|--------|---------|
| `hasEnoughSummaryText: 120 chars` | `server/src/lib/summaryOutput.ts:87-89` | Số ký tự **sau khi bóc hết markdown** (`#*_\`- ` và whitespace). Đây là nguyên nhân chính gây `isUsable=false` dù tldr và markdown có nội dung |
| Content min: 500 chars | `summarizer.ts:200` | Bài non-forum dưới 500 ký tự → skip |
| Gemini `maxOutputTokens ≥ 16384` | `ai-client.ts` | Thinking model cần budget cho thoughts, nếu thấp hơn → empty response |
| `MAX_AI_CALLS_PER_RUN: 30` | env | Số bài tối đa mỗi lần chạy summarize job |
| Raw output truncation: 8000 | `summarizer.ts:429` | Raw output gửi vào repair prompt bị cắt ở 8000 ký tự |

### Các lỗi thường gặp & cách chẩn đoán

| Thông báo lỗi | Nguyên nhân | Cách xử lý |
|---|---|---|
| `AI summary output unusable after repair: isUsable=false, tldrLength=X, markdownLength=Y` | Markdown sau khi bóc ký tự định dạng < 120 chars. Thường do nguồn **paywall** (Bloomberg, Haaretz) nội dung ngắn, AI không có đủ chất liệu để viết dài hơn | Reset về pending thử lại, hoặc skip nếu nguồn quá ngắn |
| `AI summary output unusable after repair: isUsable=false, tldrLength=0, markdownLength=0` | AI trả về JSON rỗng hoặc không parse được | Kiểm tra model đang dùng, thử đổi model |
| `finishReason=MAX_TOKENS` + empty parts | Gemini thinking model ăn hết token budget | Kiểm tra `max_tokens ≥ 16384`, set `thinking_budget=0` trong `extra_config` |
| `AI Provider rejected the request due to safety/refusal filters` | Nội dung bị AI từ chối vì safety | Pipeline tự thử safe fallback; nếu fallback cũng fail → `skipped` |
| `Skipped: source content too short` | Bài non-forum < 500 ký tự | Bình thường, không phải lỗi |
| `Skipped: promotional/deal article` | Bài bị lọc promo (keyword hoặc AI classify) | Bình thường, không phải lỗi |

**Lưu ý về repair pipeline:** Repair chỉ định dạng lại output (convert sang JSON, sửa lỗi dịch, xóa lặp), **không thể làm dài thêm nội dung**. Nếu nguồn paywall quá ngắn, repair sẽ luôn thất bại.

## Key Source Files (cho debug)

| File | Chức năng |
|------|-----------|
| `server/src/services/summarizer.ts` | Pipeline chính: prompt builder, summarize, repair, safe fallback, digest |
| `server/src/lib/summaryOutput.ts` | Parse AI output → JSON, tính `isUsable`, `hasEnoughSummaryText` |
| `server/src/lib/summaryValidation.ts` | `assertUsableSummaryOutput` — throw nếu output không đạt |
| `server/src/services/ai-client.ts` | Multi-provider AI dispatch, Gemini token fix |
| `server/src/routes/articles.ts` | API articles (list, search, reset-summary, rescrape) |
| `server/src/lib/articleFilters.ts` | SQL builder cho filter/sort article list |
| `server/src/services/fetchers/` | Các fetcher: RSS, web, Reddit, VOZ, MSN, GitHub Trending |
| `server/src/services/scraper.ts` | Orchestrator scrape: gọi fetcher → lưu article |
| `server/src/jobs/scheduler.ts` | Cron scheduler cho các job định kỳ |
| `client/src/pages/Home.tsx` | Trang chính người dùng |
| `client/src/pages/admin/` | Trang admin |

## Key Conventions

- Code bằng tiếng Anh, giao tiếp bằng tiếng Việt
- Test: `npm test` trong `server/`
- AI providers cấu hình trong DB table `ai_providers`, routing trong `app_settings`
- API response format: `{ success: boolean, data: ..., error?: { code: string, message: string } }`

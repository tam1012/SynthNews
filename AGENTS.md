# SynthNews — Agent Instructions

## Deployment

**QUAN TRỌNG: Dự án này dùng GitHub Actions tự động deploy.**

Khi push lên branch `main`, workflow `.github/workflows/deploy.yml` sẽ:
1. SSH vào Oracle VPS (`158.178.239.119`)
2. `git pull` → `docker compose up -d --build`
3. Chạy health check + smoke test tự động

**KHÔNG cần deploy thủ công trên VPS sau khi push.** Chỉ cần commit, push,
rồi GitHub Actions lo phần còn lại. Nếu cần thao tác DB thủ công (reset
trạng thái bài viết, sửa dữ liệu...) thì mới SSH vào VPS.

## Project Structure

- `server/` — Backend Node.js (Hono framework, TypeScript, PostgreSQL)
- `client/` — Frontend (Vite + vanilla JS)
- `scrapling-sidecar/` — Python sidecar cho browser-based scraping
- `scripts/` — Utility scripts (backup, restart, cookie refresh)

## VPS Info

- Host: Oracle Singapore ARM (`158.178.239.119`)
- Containers: `newstamhv-app`, `newstamhv-db` (Postgres 16), `newstamhv-scrapling`
- DB port mapping: `127.0.0.1:5433 → 5432` (container)
- App port mapping: `127.0.0.1:3001 → 3000` (container)
- Public URL: https://synthnews.site

## Key Conventions

- Code bằng tiếng Anh, giao tiếp bằng tiếng Việt
- Test: `npm test` trong `server/`
- AI providers cấu hình trong DB table `ai_providers`, routing trong `app_settings`

## Core Workflow

Luồng xử lý bài viết (cron jobs):
1. **Discover/Scrape**: Tìm bài mới từ RSS hoặc Web scraping. Lưu vào bảng `articles` với `summary_status = 'pending'`.
2. **Fetch**: Tải nội dung text đầy đủ của bài báo.
3. **Summarize**: Chạy AI tóm tắt nội dung (`services/summarizer.ts`). Bài không đạt chất lượng, quá ngắn, hoặc bị paywall sẽ vào mục `skipped`. Bài lỗi không thể cứu chữa (timeout, error) sẽ thành `failed`.
4. **Digest**: Gom các bài `done` trong 24h lại thành bản tin tổng hợp hàng ngày.

## Debugging on VPS

Khi cần viết script chạy trực tiếp trên VPS, đặc biệt lưu ý về DB:
- Biến `DATABASE_URL` trong file `.env` của VPS dùng hostname `db` (chỉ dùng trong mạng Docker nội bộ).
- **Nếu chạy script Node trực tiếp trên host VPS** (bên ngoài Docker), PHẢI set đè `DATABASE_URL` qua port localhost: `postgres://newstamhv:...@127.0.0.1:5433/newstamhv`.
- Khởi tạo kết nối DB phải chú ý thứ tự: do driver `pg` sử dụng biến môi trường ngay khi load, cần nạp `.env` và set lại biến trước khi import các module liên quan đến DB, hoặc dùng dynamic import `await import('...')` để trì hoãn load.

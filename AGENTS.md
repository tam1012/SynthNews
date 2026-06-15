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

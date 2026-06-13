-- 019: Thêm cột is_saved và source Manual cho tính năng "Saved Items"
-- Cho phép admin lưu bài viết quan trọng và thêm URL từ bên ngoài

ALTER TABLE articles ADD COLUMN IF NOT EXISTS is_saved BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_articles_saved ON articles (is_saved, created_at DESC) WHERE is_saved = TRUE;

-- Source "Manual" cho bài thêm thủ công từ URL bên ngoài
-- is_enabled=false để scheduler không tự scrape source này
INSERT INTO sources (id, type, name, url, language, is_enabled, fetch_interval_minutes, feed_category, created_at, updated_at)
VALUES ('src_manual', 'web', 'Thêm thủ công', 'https://manual.synthnews.local', 'vi', false, 1440, 'news', NOW(), NOW())
ON CONFLICT (url) DO NOTHING;

ALTER TABLE article_fetch_jobs
  DROP CONSTRAINT IF EXISTS article_fetch_jobs_status_check;

ALTER TABLE article_fetch_jobs
  ADD CONSTRAINT article_fetch_jobs_status_check
  CHECK (status IN ('discovered', 'fetching', 'done', 'failed', 'skipped'));

ALTER TABLE article_fetch_jobs
  ADD COLUMN IF NOT EXISTS skip_reason TEXT,
  ADD COLUMN IF NOT EXISTS error_type TEXT,
  ADD COLUMN IF NOT EXISTS last_http_status INTEGER,
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_article_fetch_jobs_next_attempt
  ON article_fetch_jobs(status, next_attempt_at, updated_at);

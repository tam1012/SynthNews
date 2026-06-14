CREATE TABLE IF NOT EXISTS hosted_fetch_usage (
  provider TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  used_count INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (provider, window_start)
);

CREATE INDEX IF NOT EXISTS idx_hosted_fetch_usage_updated
  ON hosted_fetch_usage(updated_at DESC);

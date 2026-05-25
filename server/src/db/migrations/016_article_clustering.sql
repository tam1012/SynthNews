-- 016_article_clustering.sql
-- Add near-duplicate clustering: leader/follower via self-referencing parent_article_id.
-- Leader: parent_article_id IS NULL. Follower: parent_article_id = leader's id.
-- cluster_signature stores the normalized signature used at insert time (debugging/observability).

ALTER TABLE articles
  ADD COLUMN IF NOT EXISTS parent_article_id TEXT REFERENCES articles(id) ON DELETE SET NULL;

ALTER TABLE articles
  ADD COLUMN IF NOT EXISTS cluster_signature TEXT;

-- Lookup followers by leader (used in detail endpoint and feed badge counts).
CREATE INDEX IF NOT EXISTS idx_articles_parent_article_id
  ON articles(parent_article_id)
  WHERE parent_article_id IS NOT NULL;

-- Quick filter for "feed leaders only".
CREATE INDEX IF NOT EXISTS idx_articles_leaders_only
  ON articles(created_at DESC)
  WHERE parent_article_id IS NULL;

-- 017_clamp_future_published_at.sql
-- Clamp already-ingested articles whose published_at is still beyond the
-- public feed tolerance window at migration time. This keeps the rows, records
-- the original timestamp in metadata, and lets reader feeds sort by a sane
-- created_at value.

UPDATE articles
SET
  metadata = (
    CASE
      WHEN metadata IS NULL THEN '{}'::jsonb
      WHEN jsonb_typeof(metadata) = 'object' THEN metadata
      ELSE jsonb_build_object('original_metadata', metadata)
    END
  ) || jsonb_build_object(
    'publish_date_warning',
    jsonb_build_object(
      'original_published_at', published_at,
      'replacement_published_at', created_at,
      'tolerance_hours', 2,
      'source', '017_clamp_future_published_at'
    )
  ),
  published_at = created_at,
  updated_at = NOW()
WHERE published_at > NOW() + INTERVAL '2 hours';

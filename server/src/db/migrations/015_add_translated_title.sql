-- 015_add_translated_title.sql
-- Add translated_title column to articles table to support showing Vietnamese titles for foreign articles
ALTER TABLE articles ADD COLUMN IF NOT EXISTS translated_title TEXT;

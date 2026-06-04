-- 018_unblock_soft_paywalls.sql
-- These publishers ship the full article inside JSON-LD articleBody / embedded
-- state blobs (__NEXT_DATA__/__PRELOADED_STATE__) even behind their subscribe
-- overlay. As of the structured-data extractor (structured-data.ts) the fetch
-- pipeline recovers their text with no extra request or paid credit, so blocking
-- them at RSS discovery only throws away articles we can actually read.
-- Hard paywalls that ship only a lede (wsj/ft/economist/bloomberg/…) stay blocked.

DELETE FROM blocklist WHERE pattern IN (
  'wired.com',
  'theatlantic.com',
  'newyorker.com',
  'medium.com',
  'towardsdatascience.com',
  'technologyreview.com'
);

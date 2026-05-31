import { useMemo } from 'react';
import { buildFeedPreview, cleanTitle, estimateReadingTime, extractSourceLabel, formatTime, getVisibleArticleTags, isArticleFresh } from './homeHelpers';

/* Preload react-markdown on first user interaction to avoid flash on article open */
let markdownPreloaded = false;
function preloadMarkdown() {
  if (markdownPreloaded) return;
  markdownPreloaded = true;
  import('react-markdown').catch(() => { markdownPreloaded = false; });
}

export function FeedListSkeleton() {
  return (
    <>
      {[1, 2, 3, 4].map(i => (
        <div key={i} className="feed-item-skeleton">
          <div className="skeleton" style={{ height: 14, width: '30%', marginBottom: 10 }} />
          <div className="skeleton" style={{ height: 22, width: '85%', marginBottom: 8 }} />
          <div className="skeleton" style={{ height: 14, width: '100%', marginBottom: 4 }} />
          <div className="skeleton" style={{ height: 14, width: '90%', marginBottom: 4 }} />
          <div className="skeleton" style={{ height: 14, width: '60%' }} />
        </div>
      ))}
    </>
  );
}

export function ArticleDetailSkeleton() {
  return (
    <div className="detail-overlay" aria-busy="true">
      <div className="detail-panel">
        <div className="detail-pull-bar">
          <div className="detail-pull-indicator" />
        </div>
        <div className="detail-content detail-skeleton">
          <div className="skeleton" style={{ width: 96, height: 12, margin: '14px auto 10px' }} />
          <div className="skeleton" style={{ width: 160, height: 12, margin: '0 auto 28px' }} />
          <div className="skeleton" style={{ width: '78%', height: 42, margin: '0 auto 12px' }} />
          <div className="skeleton" style={{ width: '52%', height: 42, margin: '0 auto 36px' }} />
          <div className="detail-image-skeleton skeleton" />
          <div className="detail-body-skeleton">
            <div className="skeleton" style={{ width: '60%', height: 24, marginBottom: 24 }} />
            <div className="skeleton" style={{ width: '100%', height: 16, marginBottom: 10 }} />
            <div className="skeleton" style={{ width: '94%', height: 16, marginBottom: 10 }} />
            <div className="skeleton" style={{ width: '88%', height: 16, marginBottom: 10 }} />
            <div className="skeleton" style={{ width: '72%', height: 16 }} />
          </div>
        </div>
      </div>
    </div>
  );
}

export function FeedItem({
  article,
  isActive,
  isRead,
  isBookmarked,
  onToggleBookmark,
  onMuteSource,
  onClick,
}: {
  article: any;
  isActive?: boolean;
  isRead?: boolean;
  isBookmarked?: boolean;
  onToggleBookmark?: () => void;
  onMuteSource?: () => void;
  onClick: () => void;
}) {
  const sourceLabel = extractSourceLabel(article);
  const title = cleanTitle(article.translated_title || article.title);
  const time = article.published_at ? formatTime(article.published_at) : '';
  const readingTime = useMemo(() => estimateReadingTime(article), [article]);
  const visibleTags = useMemo(() => getVisibleArticleTags(article), [article]);
  const isFresh = useMemo(() => isArticleFresh(article), [article]);

  const preview = useMemo(() => {
    return buildFeedPreview(article);
  }, [article]);

  return (
    <article
      className={`feed-item ${isActive ? 'active' : ''} ${isRead ? 'is-read' : ''}`}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }}
      onMouseEnter={preloadMarkdown}
      onTouchStart={preloadMarkdown}
      tabIndex={0}
      role="button"
    >
      <div className="feed-item-meta">
        <span className={`feed-item-source source-${sourceLabel.toLowerCase().replace(/[^a-z0-9]/g, '')}`}>
          {sourceLabel}
        </span>
        {isFresh && !isRead && <span className="feed-item-state-badge is-new">Mới</span>}
        {isRead && <span className="feed-item-state-badge is-read">Đã đọc</span>}
        {time && <span className="feed-item-time">{time}</span>}
        <span className="feed-item-reading-time">{readingTime}</span>
        {article.cluster_count > 0 && (
          <span className="feed-item-cluster-badge" title={`${article.cluster_count + 1} nguồn cùng đưa tin về sự kiện này`}>
            +{article.cluster_count} nguồn
          </span>
        )}
        <span className="feed-item-actions">
          <button
            type="button"
            className={`feed-item-action-btn ${isBookmarked ? 'active' : ''}`}
            onClick={(event) => {
              event.stopPropagation();
              onToggleBookmark?.();
            }}
            title={isBookmarked ? 'Bỏ khỏi đọc sau' : 'Lưu đọc sau'}
            aria-label={isBookmarked ? 'Bỏ khỏi đọc sau' : 'Lưu đọc sau'}
          >
            {isBookmarked ? '★' : '☆'}
          </button>
          <button
            type="button"
            className="feed-item-action-btn"
            onClick={(event) => {
              event.stopPropagation();
              onMuteSource?.();
            }}
            title={`Ẩn nguồn ${sourceLabel}`}
            aria-label={`Ẩn nguồn ${sourceLabel}`}
          >
            Ẩn
          </button>
        </span>
      </div>
      <div className="feed-item-body">
        <div className="feed-item-text">
          <h3 className="feed-item-title">{title}</h3>
          <p className="feed-item-preview">{preview}</p>
          {visibleTags.length > 0 && (
            <div className="feed-item-tags" aria-label="Nhãn bài viết">
              {visibleTags.map((tag) => (
                <span key={tag} className="feed-item-tag">{tag}</span>
              ))}
            </div>
          )}
        </div>
      </div>
    </article>
  );
}

/* ── Article Detail (fullscreen overlay) ── */

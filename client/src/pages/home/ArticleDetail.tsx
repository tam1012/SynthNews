import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../services/api';
import { cleanTitle, estimateReadingTime, extractSourceLabel, hideBrokenImage, hideTinyImage, proxyImgUrl } from './homeHelpers';

const ReactMarkdown = lazy(() => import('react-markdown'));

export function ArticleDetail({
  article,
  onClose,
  onPrevArticle,
  onNextArticle,
  hasPrevArticle,
  hasNextArticle,
  navIndex,
  navTotal,
}: {
  article: any;
  onClose: () => void;
  onPrevArticle: () => void;
  onNextArticle: () => void;
  hasPrevArticle: boolean;
  hasNextArticle: boolean;
  navIndex: number;
  navTotal: number;
}) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [dragY, setDragY] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const startYRef = useRef(0);
  const startScrollRef = useRef(0);
  const startedOnPullBarRef = useRef(false);

  // Reading progress bar
  const [readingProgress, setReadingProgress] = useState(0);
  // TL;DR collapsible state
  const [tldrCollapsed, setTldrCollapsed] = useState(false);
  // Manual rescrape + summarize state
  const [rescrapeState, setRescrapeState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [rescrapeMessage, setRescrapeMessage] = useState<string>('');

  // Swipe-to-navigate refs
  const swipeStartXRef = useRef(0);
  const swipeStartYRef = useRef(0);
  const swipeLockedRef = useRef<'none' | 'horizontal' | 'vertical'>('none');
  const [swipeDeltaX, setSwipeDeltaX] = useState(0);
  const isSwipingRef = useRef(false);

  const sourceLabel = extractSourceLabel(article);
  const title = cleanTitle(article.title);

  // Auto-scroll detail panel to top when article changes
  useEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0;
    setReadingProgress(0);
    setSwipeDeltaX(0);
    setRescrapeState('idle');
    setRescrapeMessage('');
  }, [article.id]);

  // Track reading progress on scroll
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = el;
      const max = scrollHeight - clientHeight;
      setReadingProgress(max > 0 ? Math.min(1, scrollTop / max) : 0);
    };
    el.addEventListener('scroll', handleScroll, { passive: true });
    return () => el.removeEventListener('scroll', handleScroll);
  }, [article.id]);

  // Split summary into TL;DR and Body
  const summaryParts = useMemo(() => {
    const tldr = (article.tldr || '').trim();
    const rest = (article.summary_text || '').trim();
    return { tldr, rest };
  }, [article.tldr, article.summary_text]);

  // Pull-to-close + swipe-to-navigate gestures
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    startYRef.current = e.touches[0].clientY;
    startScrollRef.current = contentRef.current?.scrollTop || 0;
    startedOnPullBarRef.current = Boolean((e.target as HTMLElement | null)?.closest('.detail-pull-bar'));
    swipeStartXRef.current = e.touches[0].clientX;
    swipeStartYRef.current = e.touches[0].clientY;
    swipeLockedRef.current = 'none';
    isSwipingRef.current = false;
  }, []);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    const currentX = e.touches[0].clientX;
    const currentY = e.touches[0].clientY;
    const diffX = currentX - swipeStartXRef.current;
    const diffY = currentY - startYRef.current;

    // Lock axis after 10px movement
    if (swipeLockedRef.current === 'none' && (Math.abs(diffX) > 10 || Math.abs(diffY) > 10)) {
      swipeLockedRef.current = Math.abs(diffX) > Math.abs(diffY) ? 'horizontal' : 'vertical';
    }

    // Horizontal swipe to navigate
    if (swipeLockedRef.current === 'horizontal') {
      isSwipingRef.current = true;
      setSwipeDeltaX(diffX * 0.4);
      return;
    }

    // Vertical pull-to-close (existing logic)
    if ((startedOnPullBarRef.current || startScrollRef.current <= 0) && diffY > 0) {
      e.preventDefault();
      setIsDragging(true);
      setDragY(Math.min(diffY * 0.6, 300));
    }
  }, []);

  const handleTouchEnd = useCallback(() => {
    // Handle horizontal swipe
    if (isSwipingRef.current) {
      const threshold = 70;
      if (swipeDeltaX > threshold / 0.4 && hasPrevArticle) {
        onPrevArticle();
      } else if (swipeDeltaX < -threshold / 0.4 && hasNextArticle) {
        onNextArticle();
      }
      setSwipeDeltaX(0);
      isSwipingRef.current = false;
      return;
    }
    // Handle vertical pull-to-close
    if (isDragging) {
      if (dragY > 120) {
        onClose();
      } else {
        setDragY(0);
      }
      setIsDragging(false);
    }
  }, [isDragging, dragY, onClose, swipeDeltaX, hasPrevArticle, hasNextArticle, onPrevArticle, onNextArticle]);

  // Share handler
  const handleShare = useCallback(async () => {
    const shareUrl = `${window.location.origin}/article/${article.id}`;
    const shareData = { title: title, url: shareUrl };
    try {
      if (navigator.share) {
        await navigator.share(shareData);
      } else {
        await navigator.clipboard.writeText(shareUrl);
        // The parent component handles copy toast
      }
    } catch {
      // User cancelled share or clipboard failed — ignore
    }
  }, [article.id, title]);

  // Manual rescrape + summarize handler
  const handleRescrape = useCallback(async () => {
    if (rescrapeState === 'loading') return;
    setRescrapeState('loading');
    setRescrapeMessage('Đang lấy lại bài và xếp lịch tóm tắt...');
    try {
      const res: any = await api.rescrapeArticle(article.id);
      if (res?.success) {
        setRescrapeState('done');
        setRescrapeMessage(res.message || 'Đã yêu cầu fetch + tóm tắt lại. Tải lại bài sau khoảng 30-60s để xem kết quả.');
      } else {
        setRescrapeState('error');
        setRescrapeMessage(res?.message || 'Không cập nhật được nội dung bài.');
      }
    } catch (err: any) {
      setRescrapeState('error');
      setRescrapeMessage(err?.message || 'Lỗi khi gọi API rescrape.');
    }
  }, [article.id, rescrapeState]);

  // Backdrop click
  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === overlayRef.current) onClose();
  };

  const opacity = isDragging ? Math.max(0.2, 1 - dragY / 300) : 1;
  const panelTransform = swipeDeltaX !== 0
    ? `translateX(${swipeDeltaX}px)`
    : dragY > 0 ? `translateY(${dragY}px)` : undefined;
  const panelTransition = isDragging || isSwipingRef.current
    ? 'none'
    : 'transform 0.3s cubic-bezier(0.16,1,0.3,1)';

  return (
    <div
      className="detail-overlay"
      ref={overlayRef}
      onClick={handleBackdropClick}
      style={{ backgroundColor: `rgba(0,0,0,${0.5 * opacity})` }}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div
        className="detail-panel"
        ref={contentRef}
        style={{
          transform: panelTransform,
          transition: panelTransition,
          opacity,
        }}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        {/* Reading progress bar */}
        <div className="reading-progress-track">
          <div className="reading-progress-bar" style={{ width: `${readingProgress * 100}%` }} />
        </div>

        {/* Pull indicator */}
        <div className="detail-pull-bar">
          <div className="detail-pull-indicator" />
        </div>

        <div className="detail-mobile-header">
          <button className="detail-mobile-close" onClick={onClose} title="Đóng" aria-label="Đóng">x</button>
          <div className="detail-mobile-meta">
            <span className={`feed-item-source source-${sourceLabel.toLowerCase().replace(/[^a-z0-9]/g, '')}`}>
              {sourceLabel}
            </span>
            <span className="detail-mobile-title">{title}</span>
          </div>
        </div>

        {/* Close button */}
        <button className="detail-close" onClick={onClose} title="Đóng (Esc)" aria-label="Đóng">✕</button>

        {/* Share button (top-right, opposite close) */}
        <button className="detail-share-btn" onClick={handleShare} title="Chia sẻ" aria-label="Chia sẻ">↗</button>

        {/* Content */}
        <div className="detail-content">
          <div className="detail-meta-centered">
            <a
              href={article.url}
              target="_blank"
              rel="noopener noreferrer"
              className={`feed-item-source detail-source-link source-${sourceLabel.toLowerCase().replace(/[^a-z0-9]/g, '')}`}
              title="Mở bài gốc"
            >
              {sourceLabel} ↗
            </a>
            <div className="detail-meta-secondary">
              {article.published_at && (
                <span className="feed-item-time">
                  {new Date(article.published_at).toLocaleString('vi-VN', {
                    day: 'numeric', month: 'numeric', year: 'numeric',
                    hour: '2-digit', minute: '2-digit',
                  })}
                </span>
              )}
              <span className="detail-reading-time">{estimateReadingTime(article)}</span>
              <button
                type="button"
                className={`detail-rescrape-btn ${rescrapeState === 'loading' ? 'is-loading' : ''} ${rescrapeState === 'done' ? 'is-done' : ''} ${rescrapeState === 'error' ? 'is-error' : ''}`}
                onClick={handleRescrape}
                disabled={rescrapeState === 'loading'}
                title={rescrapeMessage || 'Fetch lại nội dung gốc và tóm tắt lại bằng AI'}
                aria-label="Fetch và tóm tắt lại bài"
              >
                <span className="detail-rescrape-icon" aria-hidden="true">
                  {rescrapeState === 'loading' ? '⟳' : rescrapeState === 'done' ? '✓' : rescrapeState === 'error' ? '!' : '↻'}
                </span>
                <span className="detail-rescrape-label">
                  {rescrapeState === 'loading' ? 'Đang xử lý' : rescrapeState === 'done' ? 'Đã yêu cầu' : 'Fetch + tóm tắt lại'}
                </span>
              </button>
            </div>
          </div>

          <h1 className="detail-title-editorial">{title}</h1>

          {rescrapeState !== 'idle' && rescrapeMessage && (
            <div className={`detail-rescrape-banner rescrape-${rescrapeState}`} role="status" aria-live="polite">
              {rescrapeMessage}
            </div>
          )}

          {summaryParts.tldr && (
            <div className={`ai-tldr-box ${tldrCollapsed ? 'collapsed' : ''}`}>
              <button
                className="ai-tldr-header"
                onClick={() => setTldrCollapsed(prev => !prev)}
                aria-expanded={!tldrCollapsed}
                type="button"
              >
                <svg className="ai-tldr-sparkle" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d="M12 2L13.5 8L20 9.5L13.5 11L12 17L10.5 11L4 9.5L10.5 8Z"/>
                  <path d="M19 15L19.7 17L22 17.5L19.7 18L19 20L18.3 18L16 17.5L18.3 17Z" opacity="0.6"/>
                </svg>
                <span>Tóm tắt nhanh bởi AI</span>
                <span className="ai-tldr-toggle">{tldrCollapsed ? '▸' : '▾'}</span>
              </button>
              <div className="ai-tldr-body">
                <p>{summaryParts.tldr}</p>
              </div>
            </div>
          )}

          {article.image_url && (
            <img
              src={proxyImgUrl(article.image_url, 'detail', article.url)}
              alt=""
              className="detail-image"
              loading="eager"
              decoding="async"
              onLoad={(e) => hideTinyImage(e.currentTarget)}
              onError={(e) => hideBrokenImage(e.currentTarget)}
            />
          )}

          <div className="detail-body">
            {article.summary_text ? (
              <div className="article-main-content">
                <Suspense fallback={<div className="loading">Đang tải...</div>}>
                  <ReactMarkdown
                    components={{
                      img: ({ node, ...props }) => (
                        <img {...props} src={proxyImgUrl(props.src, 'detail')} loading="lazy" decoding="async" />
                      )
                    }}
                  >
                    {summaryParts.rest}
                  </ReactMarkdown>
                </Suspense>
              </div>
            ) : (
              <p>{article.raw_excerpt || 'Chưa có tóm tắt.'}</p>
            )}
          </div>
        </div>

        <div className="detail-reading-nav" aria-label="Chuyển bài">
          <button className="detail-reading-nav-btn" onClick={onPrevArticle} disabled={!hasPrevArticle} title="Bài trước">
            ‹
          </button>
          <span className="detail-reading-nav-status">{navIndex} / {navTotal}</span>
          <button className="detail-reading-nav-btn" onClick={onNextArticle} disabled={!hasNextArticle} title="Bài sau">
            ›
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Digest Tab ── */

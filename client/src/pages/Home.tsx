import { useEffect, useMemo, useState, useRef, useCallback, startTransition } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { api } from '../services/api';
import { useFetchRaw } from '../hooks/useApi';
import { filterArticlesBySelectedDate, formatDateDeepLink, getEmptyFeedMessage, getReaderLoadingState, parseDateDeepLinkPath, shouldShowDetailPane, shouldShowRightPane, shouldShowScrollTopButton, stepSelectedDate } from './homeUx';
import { ArticleDetail } from './home/ArticleDetail';
import { DigestTab } from './home/DigestTab';
import { ArticleDetailSkeleton, FeedItem, FeedListSkeleton } from './home/FeedItem';
import { ReadmeWelcome } from './home/ReadmeWelcome';
import {
  classifyArticle,
  cleanTitle,
  filterPersonalizedArticles,
  formatDateHeading,
  formatTime,
  loadBookmarkedArticles,
  loadMutedTags,
  loadReadArticles,
  saveBookmarkedArticles,
  saveMutedTags,
  saveReadArticles,
  toggleListValue,
} from './home/homeHelpers';

const FEED_PAGE_SIZE = 40;

export function Home() {
  const location = useLocation();
  const navigate = useNavigate();
  const { articleId: urlArticleId } = useParams<{ articleId?: string }>();
  const hasArticleDeepLink = Boolean(urlArticleId);
  const linkedDate = useMemo(() => parseDateDeepLinkPath(location.pathname), [location.pathname]);
  const linkedDigestId = useMemo(() => new URLSearchParams(location.search).get('digestId'), [location.search]);

  // Derive initial tab from URL path
  const initialTab = useMemo(() => {
    const path = location.pathname;
    if (path === '/voz') return 'voz' as const;
    if (path === '/reddit') return 'reddit' as const;
    if (path === '/digest') return 'digest' as const;
    if (path === '/news') return 'news' as const;
    if (path === '/tech') return 'tech' as const;
    return 'all' as const;
  }, []); // only on mount

  const [selected, setSelected] = useState<any | null>(null);
  const [tab, setTab] = useState<'all' | 'news' | 'tech' | 'voz' | 'reddit' | 'digest'>(initialTab);
  const [selectedDigestId, setSelectedDigestId] = useState<string | null>(() => linkedDigestId);
  const [userSelectedDate, setUserSelectedDate] = useState<string | null>(() => linkedDate);

  // Sync tab when URL changes (e.g. sidebar navigation)
  useEffect(() => {
    const path = location.pathname;
    const pathDate = parseDateDeepLinkPath(path);
    let newTab: 'all' | 'news' | 'tech' | 'voz' | 'reddit' | 'digest' = 'all';
    if (path === '/voz') newTab = 'voz';
    else if (path === '/reddit') newTab = 'reddit';
    else if (path === '/digest') newTab = 'digest';
    else if (path === '/news') newTab = 'news';
    else if (path === '/tech') newTab = 'tech';
    if (pathDate) {
      setUserSelectedDate(pathDate);
      setSelected(null);
      setFilterTag('');
    }
    if (newTab !== tab && !path.startsWith('/article')) {
      setTab(newTab);
      setSelected(null);
      setFilterTag('');
    }
  }, [location.pathname]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (location.pathname === '/digest') setSelectedDigestId(linkedDigestId);
  }, [linkedDigestId, location.pathname]);
  const [filterSource, setFilterSource] = useState<string>('all');
  const [filterTag, setFilterTag] = useState<string>('');
  const [showFilter, setShowFilter] = useState(false);
  const [showTagMenu, setShowTagMenu] = useState(false);
  const tagMenuRef = useRef<HTMLDivElement>(null);

  // Drag-to-scroll for filters row on desktop
  const filterControlRef = useRef<HTMLDivElement>(null);
  const filtersRowRef = useRef<HTMLDivElement>(null);
  const dragState = useRef({ isDown: false, startX: 0, scrollLeft: 0 });
  const handleFiltersDrag = useMemo(() => ({
    onMouseDown: (e: React.MouseEvent) => {
      const el = filtersRowRef.current;
      if (!el) return;
      dragState.current = { isDown: true, startX: e.pageX - el.offsetLeft, scrollLeft: el.scrollLeft };
      el.style.cursor = 'grabbing';
    },
    onMouseLeave: () => {
      dragState.current.isDown = false;
      if (filtersRowRef.current) filtersRowRef.current.style.cursor = '';
    },
    onMouseUp: () => {
      dragState.current.isDown = false;
      if (filtersRowRef.current) filtersRowRef.current.style.cursor = '';
    },
    onMouseMove: (e: React.MouseEvent) => {
      if (!dragState.current.isDown) return;
      e.preventDefault();
      const el = filtersRowRef.current;
      if (!el) return;
      const x = e.pageX - el.offsetLeft;
      el.scrollLeft = dragState.current.scrollLeft - (x - dragState.current.startX);
    },
  }), []);
  const [readArticleIds, setReadArticleIds] = useState<string[]>(() => loadReadArticles());
  const [bookmarkedArticleIds, setBookmarkedArticleIds] = useState<string[]>(() => loadBookmarkedArticles());
  const [mutedTags, setMutedTags] = useState<string[]>(() => loadMutedTags());
  const [bookmarkedOnly, setBookmarkedOnly] = useState(false);
  const [deepLinkLoading, setDeepLinkLoading] = useState(hasArticleDeepLink);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showScrollTop, setShowScrollTop] = useState(false);
  const [toolbarHidden, setToolbarHidden] = useState(false);
  const lastScrollY = useRef(0);
  const [articlePages, setArticlePages] = useState<any[]>([]);
  const [articlePage, setArticlePage] = useState(1);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const splitLeftRef = useRef<HTMLDivElement>(null);

  // Fetch available dates
  const { data: datesRaw, loading: datesLoading } = useFetchRaw(
    () => api.getArticleDates(filterSource === 'all' ? undefined : filterSource),
    [filterSource]
  );
  const availableDates: { date: string, count: number }[] = useMemo(() => {
    const today = new Date();
    today.setHours(23, 59, 59, 999);
    return (datesRaw?.data || []).filter((d: { date: string }) => new Date(d.date) <= today);
  }, [datesRaw]);

  // Single source of truth for date ordering (newest-first). The server already
  // returns DESC, but offline/cache merges can reorder, so sort defensively here.
  const sortedDates = useMemo(
    () => [...availableDates].sort((a, b) => b.date.localeCompare(a.date)),
    [availableDates]
  );

  // Derive effective date synchronously — no useEffect race condition
  const selectedDate = useMemo(() => {
    if (linkedDate) return linkedDate;
    if (sortedDates.length === 0) return null;
    if (userSelectedDate && sortedDates.find(d => d.date === userSelectedDate)) {
      return userSelectedDate;
    }
    return sortedDates[0].date;
  }, [sortedDates, userSelectedDate, linkedDate]);

  // Wrapper to keep setSelectedDate API for the rest of the component
  const setSelectedDate = useCallback((date: string | null) => {
    setUserSelectedDate(date);
    const datePath = formatDateDeepLink(date);
    if (datePath) navigate(datePath, { replace: true });
  }, [navigate]);

  const selectedDateIdx = useMemo(
    () => sortedDates.findIndex(d => d.date === selectedDate),
    [sortedDates, selectedDate]
  );

  const { data: raw, loading, error, reload } = useFetchRaw(
    () => {
      // Wait for dates to load before fetching articles (prevents empty flash)
      if (datesLoading && !datesRaw) return Promise.resolve({ data: [], meta: { total: 0, page: 1, totalPages: 0 } });
      return api.getArticles({ page: 1, limit: FEED_PAGE_SIZE, status: 'done', date: selectedDate || undefined, sourceId: filterSource === 'all' ? undefined : filterSource, feedTab: tab === 'digest' ? 'all' : tab, tag: filterTag || undefined });
    },
    [selectedDate, filterSource, datesLoading, tab, filterTag]
  );

  useEffect(() => {
    setArticlePages(raw?.data || []);
    setArticlePage(1);
    setLoadMoreError(null);
  }, [raw]);

  const allArticles: any[] = useMemo(() => filterArticlesBySelectedDate(articlePages, selectedDate), [articlePages, selectedDate]);
  const isShowingOfflineCache = Boolean(raw?.offline || raw?.stale || datesRaw?.offline || datesRaw?.stale);

  const articles: any[] = useMemo(() => filterPersonalizedArticles(allArticles, {
    mutedTags,
    bookmarkedArticleIds,
    bookmarkedOnly,
  }), [allArticles, bookmarkedArticleIds, bookmarkedOnly, mutedTags]);
  const hasMoreArticles = Boolean(raw?.meta && articlePages.length < raw.meta.total);
  const loadedArticleCount = articlePages.length;
  const totalArticleCount = raw?.meta?.total || loadedArticleCount;

  // Unique sources for filter (fetch all sources to be safe, but since we are filtering by date, we might miss sources. Ideally we fetch from a sources list)
  // We'll use api.getSources() for a full list, but for now we keep using the current articles if we don't have a separate fetch.
  // Actually, to make filter work properly across dates, we should fetch /sources.
  const { data: sourcesRaw } = useFetchRaw(() => api.getSources(), []);
  const sources = useMemo(() => (sourcesRaw?.data || []).filter((s: any) => s.is_enabled), [sourcesRaw]);

  // Fetch digest list for split-left panel when on digest tab
  const { data: digestListRaw, loading: digestListLoading } = useFetchRaw(
    () => tab === 'digest' ? api.getDigests(1) : Promise.resolve({ data: [] }),
    [tab]
  );
  const digestList: any[] = useMemo(() => (digestListRaw as any)?.data || [], [digestListRaw]);

  // Fetch popular tags for topic chips
  const { data: tagsRaw } = useFetchRaw(
    () => api.getArticleTags({ feedTab: tab === 'digest' ? 'all' : tab, date: selectedDate || undefined }),
    [tab, selectedDate]
  );
  const popularTags: { tag: string; count: number }[] = useMemo(() => tagsRaw?.data || [], [tagsRaw]);
  // After filter changes, scroll the active chip into center view
  const scrollActiveChipToCenter = useCallback(() => {
    const el = filtersRowRef.current;
    if (!el) return;
    const activeChip = el.querySelector('.topic-chip.active') as HTMLElement;
    if (activeChip) {
      const containerRect = el.getBoundingClientRect();
      const chipRect = activeChip.getBoundingClientRect();
      const scrollTarget = el.scrollLeft + (chipRect.left - containerRect.left) - (containerRect.width / 2) + (chipRect.width / 2);
      el.scrollTo({ left: Math.max(0, scrollTarget), behavior: 'smooth' });
    }
  }, []);
  useEffect(() => {
    if (!filterTag) return;
    // Retry at multiple intervals to handle React re-render timing
    const t1 = setTimeout(scrollActiveChipToCenter, 50);
    const t2 = setTimeout(scrollActiveChipToCenter, 300);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [filterTag, scrollActiveChipToCenter]);

  useEffect(() => {
    if (!filterTag || popularTags.some(t => t.tag === filterTag)) return;
    setFilterTag('');
  }, [filterTag, popularTags]);

  useEffect(() => {
    if (!showFilter && !showTagMenu) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (showFilter && !filterControlRef.current?.contains(event.target as Node)) {
        setShowFilter(false);
      }
      if (showTagMenu && !tagMenuRef.current?.contains(event.target as Node)) {
        setShowTagMenu(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showFilter, showTagMenu]);

  const readArticleSet = useMemo(() => new Set(readArticleIds), [readArticleIds]);
  const bookmarkedArticleSet = useMemo(() => new Set(bookmarkedArticleIds), [bookmarkedArticleIds]);

  const readerLoadingState = getReaderLoadingState({ isFeedLoading: loading, hasArticleDeepLink });
  const detailPaneVisible = shouldShowDetailPane({
    tab,
    hasSelectedArticle: Boolean(selected),
    hasArticleDeepLink,
  });
  const rightPaneVisible = shouldShowRightPane({
    tab,
    hasSelectedArticle: Boolean(selected),
    hasArticleDeepLink,
  });
  const emptyFeedMessage = getEmptyFeedMessage({
    isOfflineCache: isShowingOfflineCache,
    hasFilter: filterSource !== 'all' || tab !== 'all',
    tab,
  });

  const scrollFeedToTop = useCallback(() => {
    splitLeftRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  const handleManualRefresh = useCallback(async () => {
    setIsRefreshing(true);
    const startedAt = Date.now();
    try {
      await reload();
    } finally {
      const remainingMs = Math.max(0, 450 - (Date.now() - startedAt));
      window.setTimeout(() => setIsRefreshing(false), remainingMs);
    }
  }, [reload]);

  const handleToggleBookmark = useCallback((articleId: string) => {
    setBookmarkedArticleIds(prev => toggleListValue(prev, articleId));
  }, []);

  const handleMuteCurrentTopic = useCallback(() => {
    if (!filterTag) return;
    setMutedTags(prev => toggleListValue(prev, filterTag));
    setFilterTag('');
  }, [filterTag]);

  const clearPersonalizationFilters = useCallback(() => {
    setBookmarkedOnly(false);
    setMutedTags([]);
  }, []);

  const handleLoadMoreArticles = useCallback(async () => {
    if (isLoadingMore || !hasMoreArticles) return;
    const nextPage = articlePage + 1;
    setIsLoadingMore(true);
    setLoadMoreError(null);
    try {
      const response = await api.getArticles({ page: nextPage, limit: FEED_PAGE_SIZE, status: 'done', date: selectedDate || undefined, sourceId: filterSource === 'all' ? undefined : filterSource, feedTab: tab === 'digest' ? 'all' : tab, tag: filterTag || undefined });
      setArticlePages(prev => [...prev, ...(response?.data || [])]);
      setArticlePage(nextPage);
    } catch (err: any) {
      setLoadMoreError(err.message || 'Không thể tải thêm bài cũ.');
    } finally {
      setIsLoadingMore(false);
    }
  }, [articlePage, filterSource, filterTag, hasMoreArticles, isLoadingMore, selectedDate, tab]);

  // Date navigation handlers — operate on sortedDates (newest-first, index 0 = newest).
  // ‹ goes older, › goes newer. stepSelectedDate returns null at the ends.
  const handlePrevDate = () => {
    const next = stepSelectedDate(sortedDates, selectedDate, 'older');
    if (next) setSelectedDate(next);
  };

  const handleNextDate = () => {
    const next = stepSelectedDate(sortedDates, selectedDate, 'newer');
    if (next) setSelectedDate(next);
  };

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (showFilter) { setShowFilter(false); return; }
        if (showTagMenu) { setShowTagMenu(false); return; }
        if (selected) setSelected(null);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [selected, showFilter, showTagMenu]);

  // Lock body scroll when detail open — use overflow approach to avoid layout jump
  useEffect(() => {
    if (!detailPaneVisible) {
      document.body.classList.remove('detail-open');
      document.documentElement.style.removeProperty('--scroll-lock-y');
      return;
    }

    const scrollY = window.scrollY;
    document.documentElement.style.setProperty('--scroll-lock-y', `-${scrollY}px`);
    document.body.classList.add('detail-open');

    return () => {
      document.body.classList.remove('detail-open');
      document.documentElement.style.removeProperty('--scroll-lock-y');
      window.scrollTo({ top: scrollY, behavior: 'instant' });
    };
  }, [detailPaneVisible]);

  // Add split-view-active class for desktop body overflow lock
  useEffect(() => {
    document.body.classList.add('split-view-active');
    return () => { document.body.classList.remove('split-view-active'); };
  }, []);
  useEffect(() => {
    const isMobile = () => window.matchMedia('(max-width: 1099px)').matches;
    const appContent = document.querySelector('.app-content');

    const updateScrollTopState = () => {
      const paneScrollY = splitLeftRef.current?.scrollTop || 0;
      const appContentScrollY = appContent?.scrollTop || 0;
      const currentY = Math.max(window.scrollY, paneScrollY, appContentScrollY);
      setShowScrollTop(shouldShowScrollTopButton(currentY, detailPaneVisible));

      // Auto-hide toolbar compact row on mobile (skip digest — no compact row)
      if (isMobile() && tab !== 'digest') {
        const delta = currentY - lastScrollY.current;
        if (delta > 8 && currentY > 80) {
          setToolbarHidden(true);
        } else if (delta < -8) {
          setToolbarHidden(false);
        }
        lastScrollY.current = currentY;
      } else {
        setToolbarHidden(false);
      }
    };

    updateScrollTopState();
    window.addEventListener('scroll', updateScrollTopState, { passive: true });
    const splitLeft = splitLeftRef.current;
    splitLeft?.addEventListener('scroll', updateScrollTopState, { passive: true });
    appContent?.addEventListener('scroll', updateScrollTopState, { passive: true });
    return () => {
      window.removeEventListener('scroll', updateScrollTopState);
      splitLeft?.removeEventListener('scroll', updateScrollTopState);
      appContent?.removeEventListener('scroll', updateScrollTopState);
    };
  }, [detailPaneVisible, tab]);

  useEffect(() => {
    saveReadArticles(readArticleIds);
  }, [readArticleIds]);

  useEffect(() => {
    saveBookmarkedArticles(bookmarkedArticleIds);
  }, [bookmarkedArticleIds]);

  useEffect(() => {
    saveMutedTags(mutedTags);
  }, [mutedTags]);

  useEffect(() => {
    document.title = selected
      ? `${cleanTitle(selected.title)} | SynthNews`
      : 'SynthNews — Tin tức tổng hợp AI';
  }, [selected]);

  // Navigate helper: sync tab to URL (no React Router re-render)
  const navigateTab = useCallback((t: 'all' | 'news' | 'tech' | 'voz' | 'reddit' | 'digest') => {
    setTab(t);
    const path = t === 'all' ? '/' : `/${t}`;
    window.history.replaceState(null, '', path);
  }, []);

  const currentFeedPath = useMemo(() => {
    const explicitDate = linkedDate || userSelectedDate;
    if (tab === 'all' && explicitDate) return formatDateDeepLink(explicitDate) || '/';
    return tab === 'all' ? '/' : `/${tab}`;
  }, [linkedDate, tab, userSelectedDate]);

  // Load article from URL deep link (/article/:id)
  useEffect(() => {
    if (!urlArticleId) {
      setDeepLinkLoading(false);
      return;
    }

    let isActive = true;
    setDeepLinkLoading(true);

    (async () => {
      try {
        const res = await api.getArticle(urlArticleId);
        if (!isActive) return;
        if (res?.data) {
          setSelected(res.data);
          setReadArticleIds(prev => (prev.includes(res.data.id) ? prev : [res.data.id, ...prev]));
          const articleTab = classifyArticle(res.data);
          setTab(articleTab);
        }
      } catch {
        if (!isActive) return;
        window.history.replaceState(null, '', '/');
      } finally {
        if (isActive) setDeepLinkLoading(false);
      }
    })();

    return () => { isActive = false; };
  }, [urlArticleId]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectArticle = useCallback((article: any) => {
    // Use startTransition so React doesn't block the current render for the detail panel
    startTransition(() => {
      setSelected(article);
      setReadArticleIds(prev => (prev.includes(article.id) ? prev : [article.id, ...prev]));
    });
    window.history.replaceState(null, '', `/article/${article.id}`);
  }, []);

  const handleSelectArticle = useCallback((article: any) => {
    selectArticle(article);
    // Stay on current feed tab, just make sure we're not on digest
    if (tab === 'digest') setTab('all');
  }, [selectArticle, tab]);

  // Open a cluster sibling by id. The sibling row in the cluster list only carries
  // a thin payload; load the full article via API before swapping it into the detail panel.
  const handleSelectArticleById = useCallback((id: string) => {
    if (!id) return;
    (async () => {
      try {
        const res: any = await api.getArticle(id);
        if (res?.data) {
          selectArticle(res.data);
          if (tab === 'digest') setTab('all');
        }
      } catch {
        // ignore — keep current article visible
      }
    })();
  }, [selectArticle, tab]);

  const selectedArticleIndex = selected ? articles.findIndex(article => article.id === selected.id) : -1;
  const hasPrevArticle = selectedArticleIndex > 0;
  const hasNextArticle = selectedArticleIndex >= 0 && selectedArticleIndex < articles.length - 1;
  const handlePrevArticle = useCallback(() => {
    if (!hasPrevArticle) return;
    selectArticle(articles[selectedArticleIndex - 1]);
  }, [articles, hasPrevArticle, selectArticle, selectedArticleIndex]);
  const handleNextArticle = useCallback(() => {
    if (!hasNextArticle) return;
    selectArticle(articles[selectedArticleIndex + 1]);
  }, [articles, hasNextArticle, selectArticle, selectedArticleIndex]);

  useEffect(() => {
    if (!selected) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        handlePrevArticle();
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        handleNextArticle();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleNextArticle, handlePrevArticle, selected]);

  if (loading && readerLoadingState === 'feed-only') {
    return (
      <div className="feed-container">
        <FeedListSkeleton />
      </div>
    );
  }

  if (error && !hasArticleDeepLink) {
    return (
      <div className="empty-state">
        <p style={{ color: 'var(--color-error)' }}>Lỗi: {error}</p>
        <button className="btn btn-primary" onClick={reload} style={{ marginTop: 12 }}>Thử lại</button>
      </div>
    );
  }

  return (
    <>
      <div className="home-split-layout">
        <div className={`split-left ${tab === 'digest' ? 'digest-mode' : ''}`} ref={splitLeftRef}>
          {/* Tab bar — Unified compact row */}
          <div className={`split-feed-toolbar ${toolbarHidden ? 'toolbar-hidden' : ''}`}>
            <div className="toolbar-compact-row">
              {tab !== 'digest' ? (
                <div className="toolbar-filter-wrap">
                  {sortedDates.length > 0 && selectedDate && (
                    <div className="compact-date-nav">
                      <button
                        className="compact-date-btn"
                        onClick={handlePrevDate}
                        disabled={selectedDateIdx < 0 || selectedDateIdx >= sortedDates.length - 1}
                      >
                        ‹
                      </button>
                      <span className="compact-date-label">
                        {(() => { const d = new Date(selectedDate); return `${d.getDate()}/${d.getMonth() + 1}`; })()}
                      </span>
                      <button
                        className="compact-date-btn"
                        onClick={handleNextDate}
                        disabled={selectedDateIdx <= 0}
                      >
                        ›
                      </button>
                    </div>
                  )}
                  <div className="feed-filter-control" ref={filterControlRef}>
                    <button
                      className={`compact-sort-btn ${filterSource !== 'all' ? 'active' : ''}`}
                      onClick={() => setShowFilter(!showFilter)}
                      type="button"
                      aria-expanded={showFilter}
                      aria-haspopup="listbox"
                      aria-label="Lọc theo nguồn tin"
                    >
                      {filterSource === 'all' ? 'Nguồn ▾' : (sources.find((s: any) => s.id === filterSource)?.name.replace(/ - .*$/, '').replace(/ RSS.*$/, '') + ' ✕')}
                    </button>
                    {showFilter && (
                      <div className="filter-dropdown">
                        <button
                          className={`filter-option ${filterSource === 'all' ? 'active' : ''}`}
                          onClick={() => { setFilterSource('all'); setShowFilter(false); }}
                        >
                          Tất cả nguồn
                        </button>
                        {sources.map((s: any) => (
                          <button
                            key={s.id}
                            className={`filter-option ${filterSource === s.id ? 'active' : ''}`}
                            onClick={() => { setFilterSource(s.id); setShowFilter(false); }}
                          >
                            {s.name.replace(/ - .*$/, '').replace(/ RSS.*$/, '')}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  {popularTags.length > 0 && (
                    <div className="compact-sort-control" ref={tagMenuRef}>
                      <button
                        className={`compact-sort-btn ${filterTag ? 'active' : ''} ${showTagMenu ? 'open' : ''}`}
                        onClick={() => setShowTagMenu(prev => !prev)}
                        type="button"
                      >
                        {filterTag || 'Chủ đề'} ▾
                      </button>
                      {showTagMenu && (
                        <div className="compact-sort-dropdown">
                          <button
                            className={`filter-option ${!filterTag ? 'active' : ''}`}
                            onClick={() => { setFilterTag(''); setShowTagMenu(false); }}
                          >
                            Tất cả chủ đề
                          </button>
                          {popularTags.slice(0, 12).map(t => (
                            <button
                              key={t.tag}
                              className={`filter-option ${filterTag === t.tag ? 'active' : ''}`}
                              onClick={() => { setFilterTag(filterTag === t.tag ? '' : t.tag); setShowTagMenu(false); }}
                            >
                              {t.tag} ({t.count})
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                  <button
                    className={`compact-sort-btn ${bookmarkedOnly ? 'active' : ''}`}
                    onClick={() => setBookmarkedOnly(prev => !prev)}
                    type="button"
                    title="Chỉ hiện bài đã lưu đọc sau"
                  >
                    ☆ Đọc sau
                  </button>
                  {filterTag && (
                    <button
                      className="compact-sort-btn"
                      onClick={handleMuteCurrentTopic}
                      type="button"
                      title={`Ẩn chủ đề ${filterTag}`}
                    >
                      Ẩn chủ đề
                    </button>
                  )}
                </div>
              ) : (
                <span className="digest-title-indicator" style={{ fontFamily: 'var(--font-heading)', fontSize: '0.92rem', fontWeight: 700, color: 'var(--color-text-secondary)' }}>
                  Bản tin hàng ngày
                </span>
              )}

              <button
                className="icon-btn toolbar-refresh-btn"
                onClick={() => void handleManualRefresh()}
                disabled={isRefreshing || loading}
                title="Làm mới"
                style={{ marginLeft: 'auto', width: 32, height: 32, fontSize: '0.85rem', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              >
                ↻
              </button>
            </div>
          </div>

          {/* Active filter indicator */}
          {tab !== 'digest' && filterSource !== 'all' && (
            <div className="filter-active">
              <span>Đang lọc: <strong>{sources.find((s: any) => s.id === filterSource)?.name.replace(/ - .*$/, '')}</strong></span>
              <button className="btn btn-sm" onClick={() => setFilterSource('all')}>✕ Bỏ lọc</button>
            </div>
          )}

          {tab !== 'digest' && (bookmarkedOnly || mutedTags.length > 0) && (
            <div className="filter-active personalization-active">
              <span>
                {bookmarkedOnly ? 'Chỉ đọc sau' : 'Đang cá nhân hóa'}
                {mutedTags.length > 0 && ` · ẩn ${mutedTags.length} chủ đề`}
              </span>
              <button className="btn btn-sm" onClick={clearPersonalizationFilters}>Bỏ cá nhân hóa</button>
            </div>
          )}

          {tab !== 'digest' && (
            <div className="feed-container">
              {isShowingOfflineCache && (
                <div className="offline-cache-banner">
                  Đang hiển thị dữ liệu đã lưu. Một số tin mới có thể chưa được cập nhật.
                </div>
              )}

              {isRefreshing && (
                <div className="feed-refresh-row">
                  Đang cập nhật tin mới...
                </div>
              )}

              {loading ? (
                <FeedListSkeleton />
              ) : error ? (
                <div className="empty-state">
                  <p style={{ color: 'var(--color-error)' }}>Lỗi: {error}</p>
                  <button className="btn btn-primary" onClick={reload} style={{ marginTop: 12 }}>Thử lại</button>
                </div>
              ) : articles.length === 0 ? (
                <div className="empty-state">
                  <h2>Chưa có tin tức</h2>
                  <p style={{ marginTop: 8 }}>{emptyFeedMessage}</p>
                  <button className="btn btn-primary" onClick={() => void handleManualRefresh()} style={{ marginTop: 16 }}>Tải lại</button>
                </div>
              ) : (
                <>
                  <div className="feed-day-group">
                    {articles.map((article) => (
                      <FeedItem
                        key={article.id}
                        article={article}
                        isActive={selected?.id === article.id}
                        isRead={readArticleSet.has(article.id)}
                        isBookmarked={bookmarkedArticleSet.has(article.id)}
                        onToggleBookmark={() => handleToggleBookmark(article.id)}
                        onClick={() => handleSelectArticle(article)}
                      />
                    ))}
                  </div>
                  <div className="feed-load-more">
                    {loadMoreError && <p className="feed-load-more-error">{loadMoreError}</p>}
                    {hasMoreArticles ? (
                      <button className="btn btn-ghost" onClick={() => void handleLoadMoreArticles()} disabled={isLoadingMore}>
                        {isLoadingMore ? 'Đang tải thêm...' : `Tải thêm bài cũ (${loadedArticleCount}/${totalArticleCount})`}
                      </button>
                    ) : (
                      <p>Đã hiển thị hết bài trong ngày này.</p>
                    )}
                  </div>
                </>
              )}

              <div className="reader-footer">
                <p>Nguồn mặc định cào mỗi 60 phút và tự backoff khi lỗi · Fetch bài mỗi 5 phút · Tóm tắt AI mỗi 10 phút</p>
              </div>
            </div>
          )}

          {tab === 'digest' && (
            <div className="feed-container">
              {digestListLoading ? (
                <FeedListSkeleton />
              ) : digestList.length === 0 ? (
                <div className="empty-state"><p>Chưa có bản tin nào.</p></div>
              ) : (
                <div className="feed-day-group">
                  {digestList.map((item: any) => (
                    <div
                      key={item.id}
                      className={`feed-item ${selectedDigestId === item.id || (!selectedDigestId && digestList[0]?.id === item.id) ? 'active' : ''}`}
                      onClick={() => {
                        setSelectedDigestId(item.id);
                        window.history.replaceState(null, '', `/digest?digestId=${encodeURIComponent(item.id)}`);
                      }}
                    >
                      <div className="feed-item-text">
                        <h3 className="feed-item-title">{item.title || `Bản tin ${item.digest_date}`}</h3>
                        <div className="feed-item-meta">
                          {formatDateHeading(item.digest_date)} · {formatTime(item.created_at)} · {item.article_count} tin
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      
        <div className={`split-right ${!rightPaneVisible ? 'hidden-on-mobile' : ''}`}>
          {tab === 'digest' ? (
            <DigestTab digestId={selectedDigestId} />
          ) : selected ? (
            <ArticleDetail
              article={selected}
              isBookmarked={bookmarkedArticleSet.has(selected.id)}
              onClose={() => {
                setSelected(null);
                // Navigate back to current feed URL (no React Router re-render)
                window.history.replaceState(null, '', currentFeedPath);
              }}
              onToggleBookmark={() => handleToggleBookmark(selected.id)}
              onPrevArticle={handlePrevArticle}
              onNextArticle={handleNextArticle}
              hasPrevArticle={hasPrevArticle}
              hasNextArticle={hasNextArticle}
              navIndex={selectedArticleIndex + 1}
              navTotal={articles.length}
              onSelectArticle={handleSelectArticleById}
            />
          ) : hasArticleDeepLink && deepLinkLoading ? (
            <ArticleDetailSkeleton />
          ) : (
            <ReadmeWelcome />
          )}
        </div>
      </div>

      {showScrollTop && (
        <button className="scroll-top-button" onClick={scrollFeedToTop} aria-label="Lên đầu danh sách">
          ↑
        </button>
      )}

    </>
  );
}

/* ── Feed Item (list row) ── */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../services/api';
import { formatTime } from '../pages/home/homeHelpers';

interface SearchModalProps {
  open: boolean;
  onClose: () => void;
}

type SearchContentType = 'all' | 'news' | 'tech' | 'voz' | 'reddit' | 'digest';
type SearchResult = {
  id: string;
  title?: string;
  source_name?: string;
  published_at?: string;
  created_at?: string;
  summary_short?: string;
  digest_date?: string;
  article_count?: number;
  result_type?: 'article' | 'digest';
};

const SEARCH_CONTENT_TYPES: { value: SearchContentType; label: string }[] = [
  { value: 'all', label: 'Tất cả' },
  { value: 'news', label: 'News' },
  { value: 'tech', label: 'Tech' },
  { value: 'voz', label: 'VOZ' },
  { value: 'reddit', label: 'Reddit' },
  { value: 'digest', label: 'Bản tin' },
];

export function SearchModal({ open, onClose }: SearchModalProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchDate, setSearchDate] = useState('');
  const [sourceId, setSourceId] = useState('all');
  const [contentType, setContentType] = useState<SearchContentType>('all');
  const [sources, setSources] = useState<any[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const requestIdRef = useRef(0);
  const articleFeedTab = useMemo(() => {
    return contentType === 'digest' || contentType === 'all' ? undefined : contentType;
  }, [contentType]);

  // Focus input when modal opens
  useEffect(() => {
    if (open) {
      setQuery('');
      setResults([]);
      setSearchDate('');
      setSourceId('all');
      setContentType('all');
      setLoading(false);
      requestIdRef.current += 1;
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let active = true;
    api.getSources()
      .then((res) => {
        if (!active) return;
        setSources((res.data || []).filter((source: any) => source.is_enabled !== false));
      })
      .catch(() => {
        if (active) setSources([]);
      });
    return () => { active = false; };
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [open, onClose]);

  // Global Ctrl+K / Cmd+K shortcut
  useEffect(() => {
    const handleGlobal = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        if (open) onClose();
        else {
          // Parent handles opening — this is just for closing
        }
      }
    };
    window.addEventListener('keydown', handleGlobal);
    return () => window.removeEventListener('keydown', handleGlobal);
  }, [open, onClose]);

  const doSearch = useCallback(async (q: string) => {
    if (q.length < 2) {
      setResults([]);
      return;
    }
    const requestId = ++requestIdRef.current;
    setLoading(true);
    try {
      if (contentType === 'digest') {
        const res = await api.searchDigests(q, {
          limit: 20,
          date: searchDate || undefined,
        });
        if (requestId === requestIdRef.current) {
          setResults((res.data || []).map((item: SearchResult) => ({ ...item, result_type: 'digest' })));
        }
      } else {
        const res = await api.searchArticles(q, {
          limit: 20,
          date: searchDate || undefined,
          sourceId: sourceId === 'all' ? undefined : sourceId,
          feedTab: articleFeedTab,
        });
        if (requestId === requestIdRef.current) {
          setResults((res.data || []).map((item: SearchResult) => ({ ...item, result_type: 'article' })));
        }
      }
    } catch {
      if (requestId === requestIdRef.current) setResults([]);
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [articleFeedTab, contentType, searchDate, sourceId]);

  useEffect(() => {
    clearTimeout(debounceRef.current);
    const q = query.trim();
    if (!open) return;
    if (q.length < 2) {
      setResults([]);
      setLoading(false);
      return;
    }
    debounceRef.current = setTimeout(() => doSearch(q), 300);
    return () => clearTimeout(debounceRef.current);
  }, [doSearch, open, query]);

  const handleInputChange = (value: string) => {
    setQuery(value);
  };

  const handleContentTypeChange = (value: SearchContentType) => {
    setContentType(value);
    if (value === 'digest') setSourceId('all');
  };

  const handleSelect = (item: SearchResult) => {
    onClose();
    if (item.result_type === 'digest') {
      navigate(`/digest?digestId=${encodeURIComponent(item.id)}`);
      return;
    }
    navigate(`/article/${item.id}`);
  };

  if (!open) return null;

  return (
    <div className="search-overlay" onClick={onClose}>
      <div className="search-modal" onClick={(e) => e.stopPropagation()}>
        <div className="search-input-wrapper">
          <svg className="search-input-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input
            ref={inputRef}
            type="text"
            className="search-input"
            placeholder="Tìm kiếm bài viết hoặc bản tin..."
            value={query}
            onChange={(e) => handleInputChange(e.target.value)}
          />
          <kbd className="search-kbd">Esc</kbd>
        </div>

        <div className="search-filters">
          <label className="search-filter-field">
            <span className="search-filter-label">Ngày</span>
            <input
              className="search-filter-control"
              type="date"
              value={searchDate}
              onChange={(e) => setSearchDate(e.target.value)}
            />
          </label>
          <label className="search-filter-field">
            <span className="search-filter-label">Nguồn</span>
            <select
              className="search-filter-control"
              value={sourceId}
              onChange={(e) => setSourceId(e.target.value)}
              disabled={contentType === 'digest'}
            >
              <option value="all">Tất cả nguồn</option>
              {sources.map((source) => (
                <option key={source.id} value={source.id}>
                  {String(source.name || '').replace(/ - .*$/, '').replace(/ RSS.*$/, '')}
                </option>
              ))}
            </select>
          </label>
          <label className="search-filter-field">
            <span className="search-filter-label">Loại tin</span>
            <select
              className="search-filter-control"
              value={contentType}
              onChange={(e) => handleContentTypeChange(e.target.value as SearchContentType)}
            >
              {SEARCH_CONTENT_TYPES.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="search-results">
          {loading && (
            <div className="search-status">Đang tìm...</div>
          )}
          {!loading && query.length >= 2 && results.length === 0 && (
            <div className="search-status">Không tìm thấy bài viết nào</div>
          )}
          {!loading && query.length < 2 && query.length > 0 && (
            <div className="search-status">Nhập ít nhất 2 ký tự</div>
          )}
          {results.map((article) => {
            const isDigest = article.result_type === 'digest';
            return (
              <button
                key={article.id}
                className="search-result-item"
                onClick={() => handleSelect(article)}
              >
                <div className="search-result-title">{article.title}</div>
                <div className="search-result-meta">
                  <span className="search-result-source">
                    {isDigest ? 'Bản tin' : (article.source_name || 'Unknown')}
                  </span>
                  {isDigest && article.digest_date && (
                    <span className="search-result-time">
                      {article.digest_date}
                    </span>
                  )}
                  {!isDigest && article.published_at && (
                    <span className="search-result-time">
                      {formatTime(article.published_at)}
                    </span>
                  )}
                  {isDigest && typeof article.article_count === 'number' && (
                    <span className="search-result-time">{article.article_count} tin</span>
                  )}
                </div>
                {article.summary_short && (
                  <div className="search-result-excerpt">
                    {article.summary_short.slice(0, 120)}
                    {article.summary_short.length > 120 ? '...' : ''}
                  </div>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

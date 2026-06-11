import { lazy, Suspense, useState } from 'react';
import { api } from '../../services/api';
import { useFetchRaw } from '../../hooks/useApi';
import { buildDigestModeMarkdown, type DigestMode, formatDateHeading, formatTime, proxyImgUrl } from './homeHelpers';

const ReactMarkdown = lazy(() => import('react-markdown'));

export function DigestTab({ digestId }: { digestId?: string | null }) {
  const [internalDigestId, setInternalDigestId] = useState<string | null>(null);
  const digestMode: DigestMode = 'deep';
  const { data: digestListRaw, loading: listLoading, error: listError } = useFetchRaw(
    () => api.getDigests(1), []
  );
  const digestList = (digestListRaw as any)?.data || [];
  const activeDigestId = digestId || internalDigestId || digestList[0]?.id || null;
  const activeDigestIndex = digestList.findIndex((item: any) => item.id === activeDigestId);
  const { data: digestRaw, loading: digestLoading, error: digestError } = useFetchRaw(
    () => activeDigestId ? api.getDigest(activeDigestId) : Promise.resolve({ data: null }),
    [activeDigestId]
  );
  const digest = (digestRaw as any)?.data;
  const digestMarkdown = buildDigestModeMarkdown(digest, digestMode);
  const loading = listLoading || digestLoading;
  const error = listError || digestError;

  const selectPrev = () => {
    if (activeDigestIndex < digestList.length - 1) setInternalDigestId(digestList[activeDigestIndex + 1].id);
  };
  const selectNext = () => {
    if (activeDigestIndex > 0) setInternalDigestId(digestList[activeDigestIndex - 1].id);
  };

  if (loading && !digest) return <div className="loading" style={{ padding: 40 }}>Đang tải bản tin...</div>;
  if (error) return <div className="empty-state"><p>Chưa có bản tin tổng hợp.</p></div>;
  if (!digest) return <div className="empty-state"><p>Chưa có bản tin tổng hợp nào.</p></div>;

  return (
    <div className="feed-container digest-container">
      <div className="digest-history-nav digest-nav-mobile-only">
        <button
          className="compact-date-btn digest-history-btn"
          onClick={selectPrev}
          disabled={activeDigestIndex < 0 || activeDigestIndex === digestList.length - 1}
          title="Bản tin cũ hơn"
        >
          ‹
        </button>
        <select
          className="digest-history-select"
          value={activeDigestId || ''}
          onChange={(e) => setInternalDigestId(e.target.value)}
          aria-label="Chọn bản tin"
        >
          {digestList.map((item: any) => (
            <option key={item.id} value={item.id}>
              {formatDateHeading(item.digest_date)} · {formatTime(item.created_at)} · {item.article_count} tin
            </option>
          ))}
        </select>
        <button
          className="compact-date-btn digest-history-btn"
          onClick={selectNext}
          disabled={activeDigestIndex <= 0}
          title="Bản tin mới hơn"
        >
          ›
        </button>
      </div>
      <h2 className="feed-date-heading" style={{ paddingTop: 0 }}>{digest.title || `Bản tin ${digest.digest_date}`}</h2>
      <div className="digest-meta">
        {formatDateHeading(digest.digest_date)} · {formatTime(digest.created_at)} · {digest.article_count} tin
      </div>
      <div className="digest-content">
        <Suspense fallback={<div className="loading">Đang tải bản tin...</div>}>
          <ReactMarkdown
            components={{
              img: ({ node, ...props }) => (
                <img {...props} src={proxyImgUrl(props.src, 'detail')} loading="lazy" decoding="async" />
              )
            }}
          >
            {digestMarkdown}
          </ReactMarkdown>
        </Suspense>
      </div>
    </div>
  );
}

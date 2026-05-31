import { useState } from 'react';
import { api } from '../../services/api';
import { useFetchRaw } from '../../hooks/useApi';
import { AdminArticle, AdminPageMeta, QUALITY_ISSUES, QualityIssue, getArticleQualityIssues } from './adminHelpers';

type AdminArticlesResponse = {
  data: AdminArticle[];
  meta?: AdminPageMeta;
};

export function QualityControlTab() {
  const [issue, setIssue] = useState<QualityIssue>('missing_tldr');
  const [page, setPage] = useState(1);
  const [actionLoading, setActionLoading] = useState('');
  const { data: raw, loading, error, reload } = useFetchRaw<AdminArticlesResponse>(
    () => api.getArticles({ page, limit: 50, status: 'done', qualityIssue: issue }), [page, issue]
  );
  const articles: AdminArticle[] = raw?.data || [];
  const meta = raw?.meta || { page, total: 0, totalPages: 0 };

  const runAction = async (key: string, fn: () => Promise<unknown>) => {
    setActionLoading(key);
    try {
      await fn();
      reload();
    } catch (err: unknown) {
      alert('Lỗi: ' + (err instanceof Error ? err.message : 'Không thực hiện được thao tác.'));
    } finally {
      setActionLoading('');
    }
  };

  const handleIssueChange = (nextIssue: QualityIssue) => {
    setIssue(nextIssue);
    setPage(1);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
      <div className="card" style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontWeight: 700 }}>Kiểm tra chất lượng tóm tắt</div>
          <div style={{ fontSize: '0.78rem', color: 'var(--color-text-muted)', marginTop: 2 }}>
            Tìm bài đã tóm tắt nhưng thiếu metadata dùng cho preview, Tin nóng và lọc chủ đề.
          </div>
        </div>
        <button className="btn btn-sm" onClick={reload} disabled={loading}>Tải lại</button>
      </div>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {QUALITY_ISSUES.map(item => (
          <button
            key={item.key}
            className={`btn btn-sm ${issue === item.key ? 'btn-primary' : ''}`}
            onClick={() => handleIssueChange(item.key)}
          >
            {item.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="loading">Đang kiểm tra chất lượng...</div>
      ) : error ? (
        <div className="empty-state">
          <p style={{ color: 'var(--color-error)' }}>{error}</p>
          <button className="btn btn-primary" onClick={reload} style={{ marginTop: 12 }}>Thử lại</button>
        </div>
      ) : (
        <>
          <div style={{ fontSize: '0.82rem', color: 'var(--color-text-muted)' }}>
            Hiển thị {articles.length} / {meta.total || 0} bài · Trang {meta.page || page}/{meta.totalPages || 1}
          </div>

          {articles.map((a) => (
            <div key={a.id} className="card" style={{ padding: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'flex-start' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: '0.92rem', marginBottom: 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {a.title}
                  </div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
                    <span>{a.source_name || 'Không rõ nguồn'}</span>
                    {a.published_at && <span>{new Date(a.published_at).toLocaleString('vi-VN')}</span>}
                    <span>điểm nóng: {a.hot_score ?? '—'}</span>
                    {Array.isArray(a.tags) && a.tags.length > 0 && <span>nhãn: {a.tags.slice(0, 4).join(', ')}</span>}
                  </div>
                  <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                    {getArticleQualityIssues(a).map(label => (
                      <span key={label} className="badge badge-pending">{label}</span>
                    ))}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 4, flexShrink: 0, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                  {/voz|reddit/i.test(a.source_name || '') && (
                    <button className="btn btn-sm" onClick={() => runAction(`rescrape-${a.id}`, () => api.rescrapeArticle(a.id))} disabled={!!actionLoading}>Cào lại</button>
                  )}
                  <button className="btn btn-sm" onClick={() => runAction(`reset-${a.id}`, () => api.resetArticleSummary(a.id))} disabled={!!actionLoading}>Tóm tắt lại</button>
                  <button className="btn btn-sm btn-danger" onClick={() => { if (confirm('Xóa bài viết này?')) void runAction(`delete-${a.id}`, () => api.deleteArticle(a.id)); }} disabled={!!actionLoading}>Xóa</button>
                </div>
              </div>
            </div>
          ))}

          {articles.length === 0 && (
            <div className="empty-state"><p>Không có bài nào thuộc nhóm này.</p></div>
          )}

          <div style={{ display: 'flex', justifyContent: 'center', gap: 8, alignItems: 'center' }}>
            <button className="btn btn-sm" onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1 || loading}>Trang trước</button>
            <span style={{ fontSize: '0.8rem', color: 'var(--color-text-muted)' }}>{page}/{meta.totalPages || 1}</span>
            <button className="btn btn-sm" onClick={() => setPage(p => p + 1)} disabled={page >= (meta.totalPages || 1) || loading}>Trang sau</button>
          </div>
        </>
      )}
    </div>
  );
}


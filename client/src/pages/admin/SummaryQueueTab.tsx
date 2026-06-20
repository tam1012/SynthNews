import { useEffect, useState } from 'react';
import { api } from '../../services/api';
import { useFetchRaw } from '../../hooks/useApi';
import { AdminArticle, AdminPageMeta, SUMMARY_QUEUE_STATUSES, SummaryQueueStatus, statusLabel } from './adminHelpers';

type AdminArticlesResponse = {
  data: AdminArticle[];
  meta?: AdminPageMeta;
};

export function SummaryQueueTab({ initialStatus }: { initialStatus?: SummaryQueueStatus }) {
  const [status, setStatus] = useState<SummaryQueueStatus>(initialStatus || 'failed');
  const [page, setPage] = useState(1);
  const [actionLoading, setActionLoading] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const { data: raw, loading, error, reload } = useFetchRaw<AdminArticlesResponse>(
    () => api.getArticles({ page, limit: 50, status }), [page, status]
  );
  const articles: AdminArticle[] = raw?.data || [];
  const meta = raw?.meta || { page, total: 0, totalPages: 0 };
  const allSelected = articles.length > 0 && articles.every((a) => selectedIds.includes(a.id));

  useEffect(() => {
    setSelectedIds([]);
  }, [page, status]);

  const runAction = async (key: string, fn: () => Promise<unknown>) => {
    setActionLoading(key);
    try {
      await fn();
      setSelectedIds([]);
      reload();
    } catch (err: unknown) {
      alert('Lỗi: ' + (err instanceof Error ? err.message : 'Không thực hiện được thao tác.'));
    } finally {
      setActionLoading('');
    }
  };

  const handleStatusChange = (nextStatus: SummaryQueueStatus) => {
    setStatus(nextStatus);
    setPage(1);
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Xóa bài viết này?')) return;
    await runAction(`delete-${id}`, () => api.deleteArticle(id));
  };

  const handleReset = async (id: string) => {
    await runAction(`reset-${id}`, () => api.resetArticleSummary(id));
  };

  const handleRescrape = async (article: AdminArticle) => {
    await runAction(`rescrape-${article.id}`, () => api.rescrapeArticle(article.id));
  };

  const handleTriggerSummarize = async () => {
    await runAction('trigger-summarize', api.triggerSummarize);
  };

  const toggleSelect = (id: string) => {
    setSelectedIds(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id]);
  };

  const toggleSelectAll = () => {
    setSelectedIds(allSelected ? [] : articles.map((a) => a.id));
  };

  const handleBatchReset = async () => {
    await runAction('batch-reset', () => api.batchResetArticleSummaries(selectedIds));
  };

  const handleBatchDelete = async () => {
    if (!confirm(`Xóa ${selectedIds.length} bài viết đã chọn?`)) return;
    await runAction('batch-delete', () => api.batchDeleteArticles(selectedIds));
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
      <div className="card" style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontWeight: 700 }}>Hàng đợi dịch</div>
          <div style={{ fontSize: '0.78rem', color: 'var(--color-text-muted)', marginTop: 2 }}>
            Theo dõi bài đang chờ, đang xử lý hoặc lỗi dịch.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button className="btn btn-sm" onClick={handleTriggerSummarize} disabled={!!actionLoading}>
            {actionLoading === 'trigger-summarize' ? 'Đang chạy...' : 'Chạy dịch'}
          </button>
          <button className="btn btn-sm" onClick={reload} disabled={loading}>Tải lại</button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {SUMMARY_QUEUE_STATUSES.map(item => (
          <button
            key={item.key}
            className={`btn btn-sm ${status === item.key ? 'btn-primary' : ''}`}
            onClick={() => handleStatusChange(item.key)}
          >
            {item.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="loading">Đang tải queue...</div>
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

          {articles.length > 0 && (
            <div className="card" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', padding: 10 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.82rem', color: 'var(--color-text-muted)' }}>
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleSelectAll}
                  aria-label="Chọn tất cả bài trên trang"
                />
                Đã chọn {selectedIds.length}/{articles.length}
              </label>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <button className="btn btn-sm" onClick={handleBatchReset} disabled={selectedIds.length === 0 || !!actionLoading}>
                  {actionLoading === 'batch-reset' ? 'Đang chạy...' : 'Dịch lại đã chọn'}
                </button>
                <button className="btn btn-sm btn-danger" onClick={handleBatchDelete} disabled={selectedIds.length === 0 || !!actionLoading}>
                  {actionLoading === 'batch-delete' ? 'Đang xóa...' : 'Xóa đã chọn'}
                </button>
              </div>
            </div>
          )}

          {articles.map((a) => (
            <div key={a.id} className="card" style={{ padding: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'flex-start' }}>
                <input
                  type="checkbox"
                  checked={selectedIds.includes(a.id)}
                  onChange={() => toggleSelect(a.id)}
                  aria-label={`Chọn bài ${a.title || a.id}`}
                  style={{ marginTop: 2 }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: '0.92rem', marginBottom: 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {a.title}
                  </div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <span>{a.source_name || 'Không rõ nguồn'}</span>
                    {a.published_at && <span>{new Date(a.published_at).toLocaleString('vi-VN')}</span>}
                    <span className={`badge badge-${a.summary_status === 'done' ? 'success' : a.summary_status === 'failed' ? 'error' : 'pending'}`}>
                      {statusLabel(a.summary_status)}
                    </span>
                    <span>đã thử lại: {a.retry_count || 0}</span>
                  </div>
                  {a.last_summary_error && (
                    <div style={{ color: 'var(--color-error)', fontSize: '0.75rem', marginTop: 8, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                      {String(a.last_summary_error).substring(0, 500)}
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 4, flexShrink: 0, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                  {/voz|reddit/i.test(a.source_name || '') && (
                    <button className="btn btn-sm" onClick={() => handleRescrape(a)} disabled={!!actionLoading}>Cào lại</button>
                  )}
                  <button className="btn btn-sm" onClick={() => handleReset(a.id)} disabled={!!actionLoading}>Dịch lại</button>
                  <button className="btn btn-sm btn-danger" onClick={() => handleDelete(a.id)} disabled={!!actionLoading}>Xóa</button>
                </div>
              </div>
            </div>
          ))}

          {articles.length === 0 && (
            <div className="empty-state"><p>Không có bài nào ở trạng thái này.</p></div>
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


import { useEffect, useState } from 'react';
import { api } from '../../services/api';
import { useFetchRaw } from '../../hooks/useApi';
import { FETCH_JOB_STATUSES, FetchJobStatus, statusLabel } from './adminHelpers';

export function FetchJobsTab({ initialStatus }: { initialStatus?: FetchJobStatus }) {
  const [status, setStatus] = useState<FetchJobStatus>(initialStatus || 'failed');
  const [page, setPage] = useState(1);
  const [actionLoading, setActionLoading] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const { data: raw, loading, error, reload } = useFetchRaw(
    () => api.getArticleFetchJobs({ page, limit: 50, status }), [page, status]
  );
  const jobs: any[] = raw?.data || [];
  const meta = raw?.meta || { page, total: 0, totalPages: 0 };
  const allSelected = jobs.length > 0 && jobs.every((job: any) => selectedIds.includes(job.id));

  useEffect(() => {
    setSelectedIds([]);
  }, [page, status]);

  const runAction = async (key: string, fn: () => Promise<any>) => {
    setActionLoading(key);
    try {
      await fn();
      setSelectedIds([]);
      reload();
    } catch (err: any) {
      alert('Lỗi: ' + err.message);
    } finally {
      setActionLoading('');
    }
  };

  const handleStatusChange = (nextStatus: FetchJobStatus) => {
    setStatus(nextStatus);
    setPage(1);
  };

  const handleRetry = async (id: string) => {
    await runAction(`retry-${id}`, () => api.retryArticleFetchJob(id));
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Xóa mục lấy bài này?')) return;
    await runAction(`delete-${id}`, () => api.deleteArticleFetchJob(id));
  };

  const handleTriggerFetch = async () => {
    await runAction('trigger-fetch', api.triggerFetchArticles);
  };

  const toggleSelect = (id: string) => {
    setSelectedIds(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id]);
  };

  const toggleSelectAll = () => {
    setSelectedIds(allSelected ? [] : jobs.map((job: any) => job.id));
  };

  const handleBatchRetry = async () => {
    await runAction('batch-retry', () => api.batchRetryArticleFetchJobs(selectedIds));
  };

  const handleBatchDelete = async () => {
    if (!confirm(`Xóa ${selectedIds.length} mục lấy bài đã chọn?`)) return;
    await runAction('batch-delete', () => api.batchDeleteArticleFetchJobs(selectedIds));
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
      <div className="card" style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontWeight: 700 }}>Hàng đợi lấy bài</div>
          <div style={{ fontSize: '0.78rem', color: 'var(--color-text-muted)', marginTop: 2 }}>
            Theo dõi URL đang chờ lấy nội dung, đang lấy hoặc bị lỗi trước khi tạo bài viết.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button className="btn btn-sm" onClick={handleTriggerFetch} disabled={!!actionLoading}>
            {actionLoading === 'trigger-fetch' ? 'Đang chạy...' : 'Chạy fetch bài'}
          </button>
          <button className="btn btn-sm" onClick={reload} disabled={loading}>Tải lại</button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {FETCH_JOB_STATUSES.map(item => (
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
        <div className="loading">Đang tải hàng đợi lấy bài...</div>
      ) : error ? (
        <div className="empty-state">
          <p style={{ color: 'var(--color-error)' }}>{error}</p>
          <button className="btn btn-primary" onClick={reload} style={{ marginTop: 12 }}>Thử lại</button>
        </div>
      ) : (
        <>
          <div style={{ fontSize: '0.82rem', color: 'var(--color-text-muted)' }}>
            Hiển thị {jobs.length} / {meta.total || 0} mục · Trang {meta.page || page}/{meta.totalPages || 1}
          </div>

          {jobs.length > 0 && (
            <div className="card" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', padding: 10 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.82rem', color: 'var(--color-text-muted)' }}>
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleSelectAll}
                  aria-label="Chọn tất cả job trên trang"
                />
                Đã chọn {selectedIds.length}/{jobs.length}
              </label>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <button className="btn btn-sm" onClick={handleBatchRetry} disabled={selectedIds.length === 0 || !!actionLoading}>
                  {actionLoading === 'batch-retry' ? 'Đang chạy...' : 'Thử lại đã chọn'}
                </button>
                <button className="btn btn-sm btn-danger" onClick={handleBatchDelete} disabled={selectedIds.length === 0 || !!actionLoading}>
                  {actionLoading === 'batch-delete' ? 'Đang xóa...' : 'Xóa đã chọn'}
                </button>
              </div>
            </div>
          )}

          {jobs.map((job: any) => (
            <div key={job.id} className="card" style={{ padding: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'flex-start' }}>
                <input
                  type="checkbox"
                  checked={selectedIds.includes(job.id)}
                  onChange={() => toggleSelect(job.id)}
                  aria-label={`Chọn job ${job.title || job.url || job.id}`}
                  style={{ marginTop: 2 }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: '0.92rem', marginBottom: 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {job.title || job.url}
                  </div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <span>{job.source_name || 'Không rõ nguồn'}</span>
                    <span className={`badge badge-${job.status === 'done' ? 'success' : job.status === 'failed' ? 'error' : 'pending'}`}>
                      {statusLabel(job.status)}
                    </span>
                    <span>đã thử lại: {job.retry_count || 0}</span>
                    {job.updated_at && <span>{new Date(job.updated_at).toLocaleString('vi-VN')}</span>}
                  </div>
                  <a href={job.url} target="_blank" rel="noreferrer" style={{ display: 'block', fontSize: '0.75rem', marginTop: 6, overflowWrap: 'anywhere' }}>
                    {job.url}
                  </a>
                  {job.last_error && (
                    <div style={{ color: 'var(--color-error)', fontSize: '0.75rem', marginTop: 8, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                      {String(job.last_error).substring(0, 500)}
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 4, flexShrink: 0, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                  <button className="btn btn-sm" onClick={() => handleRetry(job.id)} disabled={!!actionLoading}>Thử lại</button>
                  <button className="btn btn-sm btn-danger" onClick={() => handleDelete(job.id)} disabled={!!actionLoading}>Xóa</button>
                </div>
              </div>
            </div>
          ))}

          {jobs.length === 0 && (
            <div className="empty-state"><p>Không có mục lấy bài nào ở trạng thái này.</p></div>
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

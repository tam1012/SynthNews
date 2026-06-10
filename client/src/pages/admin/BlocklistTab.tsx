import { useState } from 'react';
import { api } from '../../services/api';
import { useFetch } from '../../hooks/useApi';

interface BlocklistEntry {
  id: string;
  pattern: string;
  type: 'domain' | 'path';
  reason: string | null;
  is_enabled: boolean;
  hit_count: number;
  last_hit_at: string | null;
  created_at: string;
}

interface TestResult {
  url: string;
  blocked: boolean;
  match: { id: string; pattern: string; type: string; reason: string | null } | null;
}

export function BlocklistTab() {
  const { data: entries, loading, error, reload } = useFetch<BlocklistEntry[]>(() => api.getBlocklist());
  const [pattern, setPattern] = useState('');
  const [type, setType] = useState<'domain' | 'path'>('domain');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');
  const [actionLoading, setActionLoading] = useState('');
  const [testUrl, setTestUrl] = useState('');
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [filter, setFilter] = useState<'all' | 'enabled' | 'disabled'>('all');

  const list = (entries || []).filter(e => {
    if (filter === 'enabled') return e.is_enabled;
    if (filter === 'disabled') return !e.is_enabled;
    return true;
  });

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError('');
    const trimmed = pattern.trim();
    if (!trimmed) {
      setFormError('Pattern không được rỗng');
      return;
    }
    setSubmitting(true);
    try {
      const res = await api.createBlocklistEntry({ pattern: trimmed, type, reason: reason.trim() || undefined });
      if (!res.success) throw new Error(res.error?.message || 'Không thể tạo blocklist');
      setPattern('');
      setReason('');
      reload();
    } catch (err: any) {
      setFormError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const runAction = async (key: string, fn: () => Promise<any>) => {
    setActionLoading(key);
    try {
      const res = await fn();
      if (res && res.success === false) throw new Error(res.error?.message || 'Thao tác thất bại');
      reload();
    } catch (err: any) {
      alert('Lỗi: ' + err.message);
    } finally {
      setActionLoading('');
    }
  };

  const handleToggle = (entry: BlocklistEntry) =>
    runAction(`toggle-${entry.id}`, () => api.updateBlocklistEntry(entry.id, { is_enabled: !entry.is_enabled }));

  const handleEditReason = (entry: BlocklistEntry) => {
    const next = window.prompt('Lý do (paywall, antibot, ...):', entry.reason || '');
    if (next === null) return;
    runAction(`reason-${entry.id}`, () => api.updateBlocklistEntry(entry.id, { reason: next }));
  };

  const handleDelete = (entry: BlocklistEntry) => {
    if (!confirm(`Xóa pattern "${entry.pattern}"?`)) return;
    runAction(`delete-${entry.id}`, () => api.deleteBlocklistEntry(entry.id));
  };

  const handleTest = async () => {
    const trimmed = testUrl.trim();
    if (!trimmed) return;
    setTesting(true);
    try {
      const res = await api.testBlocklistUrl(trimmed);
      if (!res.success) throw new Error(res.error?.message || 'Test thất bại');
      setTestResult(res.data);
    } catch (err: any) {
      alert('Lỗi: ' + err.message);
    } finally {
      setTesting(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
      <div className="card" style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontWeight: 700 }}>Danh sách chặn URL</div>
          <div style={{ fontSize: '0.78rem', color: 'var(--color-text-muted)', marginTop: 2 }}>
            Chặn ngay khi RSS phát hiện link để khỏi tốn tài nguyên fetch các trang paywall hoặc antibot.
          </div>
        </div>
        <button className="btn btn-sm" onClick={reload} disabled={loading}>Tải lại</button>
      </div>

      <form onSubmit={handleAdd} className="card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>Thêm pattern mới</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input
            type="text"
            placeholder={type === 'domain' ? 'vd: nytimes.com' : 'vd: bbc.com/sport/'}
            value={pattern}
            onChange={e => setPattern(e.target.value)}
            disabled={submitting}
            style={{ flex: '1 1 240px', padding: '6px 10px', minWidth: 200 }}
          />
          <select value={type} onChange={e => setType(e.target.value as 'domain' | 'path')} disabled={submitting} style={{ padding: '6px 10px' }}>
            <option value="domain">domain</option>
            <option value="path">path</option>
          </select>
          <input
            type="text"
            placeholder="Lý do (tuỳ chọn): paywall, antibot, video..."
            value={reason}
            onChange={e => setReason(e.target.value)}
            disabled={submitting}
            style={{ flex: '1 1 200px', padding: '6px 10px' }}
          />
          <button type="submit" className="btn btn-primary btn-sm" disabled={submitting}>
            {submitting ? 'Đang thêm...' : 'Thêm'}
          </button>
        </div>
        {formError && <div style={{ color: 'var(--color-error)', fontSize: '0.8rem' }}>{formError}</div>}
        <div style={{ fontSize: '0.72rem', color: 'var(--color-text-muted)' }}>
          <code>domain</code> chặn cả domain (vd <code>wsj.com</code> chặn cả <code>www.wsj.com</code> và subdomain).
          {' '}<code>path</code> chỉ chặn URL chứa pattern (vd <code>bbc.com/sport/</code>).
          {' '}Dùng <code>*</code> làm ký tự đại diện cho phần thay đổi, vd <code>edition.cnn.com/*/weather/video/</code> chặn mọi link video thời tiết CNN bất kể ngày tháng.
        </div>
      </form>

      <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>Test URL</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input
            type="text"
            placeholder="https://www.example.com/path/article"
            value={testUrl}
            onChange={e => setTestUrl(e.target.value)}
            disabled={testing}
            style={{ flex: '1 1 320px', padding: '6px 10px', minWidth: 240 }}
          />
          <button type="button" className="btn btn-sm" onClick={handleTest} disabled={testing || !testUrl.trim()}>
            {testing ? 'Đang kiểm tra...' : 'Kiểm tra'}
          </button>
        </div>
        {testResult && (
          <div style={{ fontSize: '0.82rem', padding: '6px 10px', borderRadius: 4, background: testResult.blocked ? 'rgba(220, 80, 80, 0.12)' : 'rgba(80, 180, 100, 0.12)' }}>
            {testResult.blocked ? (
              <>🚫 Bị chặn bởi pattern <code>{testResult.match?.pattern}</code> ({testResult.match?.type}){testResult.match?.reason ? ` — ${testResult.match.reason}` : ''}</>
            ) : (
              <>✅ Không bị chặn — URL này sẽ được fetch bình thường</>
            )}
          </div>
        )}
      </div>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {(['all', 'enabled', 'disabled'] as const).map(key => (
          <button
            key={key}
            className={`btn btn-sm ${filter === key ? 'btn-primary' : ''}`}
            onClick={() => setFilter(key)}
          >
            {key === 'all' ? 'Tất cả' : key === 'enabled' ? 'Đang bật' : 'Đã tắt'} ({entries ? entries.filter(e => key === 'all' ? true : key === 'enabled' ? e.is_enabled : !e.is_enabled).length : 0})
          </button>
        ))}
      </div>

      {loading ? (
        <div className="loading">Đang tải blocklist...</div>
      ) : error ? (
        <div className="empty-state">
          <p style={{ color: 'var(--color-error)' }}>{error}</p>
          <button className="btn btn-primary" onClick={reload} style={{ marginTop: 12 }}>Thử lại</button>
        </div>
      ) : (
        <>
          <div style={{ fontSize: '0.82rem', color: 'var(--color-text-muted)' }}>
            Tổng {list.length} pattern · Sắp xếp theo số lần chặn (cao xuống thấp)
          </div>

          {list.map(entry => (
            <div key={entry.id} className="card" style={{ padding: 10, opacity: entry.is_enabled ? 1 : 0.55 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 240 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <code style={{ fontSize: '0.92rem', fontWeight: 600 }}>{entry.pattern}</code>
                    <span className="badge" style={{ fontSize: '0.7rem' }}>{entry.type}</span>
                    {!entry.is_enabled && <span className="badge badge-pending" style={{ fontSize: '0.7rem' }}>tắt</span>}
                  </div>
                  <div style={{ fontSize: '0.74rem', color: 'var(--color-text-muted)', marginTop: 4, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                    <span>chặn {entry.hit_count} lần</span>
                    {entry.last_hit_at && <span>lần cuối {new Date(entry.last_hit_at).toLocaleString('vi-VN')}</span>}
                    {entry.reason && <span>· {entry.reason}</span>}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                  <button
                    className="btn btn-sm"
                    onClick={() => handleToggle(entry)}
                    disabled={!!actionLoading}
                  >
                    {entry.is_enabled ? 'Tắt' : 'Bật'}
                  </button>
                  <button className="btn btn-sm" onClick={() => handleEditReason(entry)} disabled={!!actionLoading}>
                    Sửa lý do
                  </button>
                  <button className="btn btn-sm btn-danger" onClick={() => handleDelete(entry)} disabled={!!actionLoading}>
                    Xóa
                  </button>
                </div>
              </div>
            </div>
          ))}

          {list.length === 0 && (
            <div className="empty-state"><p>Không có pattern nào thuộc nhóm này.</p></div>
          )}
        </>
      )}
    </div>
  );
}

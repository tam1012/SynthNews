import { useState, useCallback } from 'react';
import { api } from '../services/api';
import { useFetch } from '../hooks/useApi';

function formatNextRun(nextRunAt: string | null | undefined): string {
  if (!nextRunAt) return 'chưa lên lịch';
  const nextRun = new Date(nextRunAt).getTime();
  const diffMinutes = Math.ceil((nextRun - Date.now()) / 60000);
  if (diffMinutes <= 0) return 'đến hạn';
  if (diffMinutes < 60) return `còn ${diffMinutes} phút`;
  return `còn ${Math.ceil(diffMinutes / 60)} giờ`;
}

export function Sources() {
  const { data: sources, loading, error, reload } = useFetch(() => api.getSources());
  const sourceList = Array.isArray(sources) ? sources : [];
  const [showForm, setShowForm] = useState(false);
  const [detectUrl, setDetectUrl] = useState('');
  const [detecting, setDetecting] = useState(false);
  const [detectResult, setDetectResult] = useState<any>(null);
  const [formData, setFormData] = useState({
    type: 'rss',
    name: '',
    url: '',
    language: 'vi',
    category: '',
    fetch_interval_minutes: 60,
    parser_config: undefined as any,
    feed_category: 'news' as 'news' | 'tech',
  });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [scrapingId, setScrapingId] = useState<string | null>(null);
  const [formError, setFormError] = useState('');
  const [toast, setToast] = useState<{ message: string; isError?: boolean } | null>(null);

  const showToast = useCallback((message: string, isError = false) => {
    setToast({ message, isError });
    setTimeout(() => setToast(null), 4000);
  }, []);

  const handleDetect = async () => {
    if (!detectUrl.trim()) return;
    setDetecting(true);
    setDetectResult(null);
    setFormError('');
    try {
      const result = await api.detectSource(detectUrl.trim());
      setDetectResult(result.data);
      if (result.data.supported === false) {
        setFormError(result.data.warnings?.[0] || 'Nguồn này chưa được hỗ trợ.');
        setShowForm(false);
        return;
      }
      setFormData({
        ...formData,
        type: result.data.type || 'web',
        name: result.data.name || '',
        url: result.data.suggested_url || result.data.url || detectUrl.trim(),
        language: result.data.preview?.language?.substring(0, 2) || 'vi',
        parser_config: result.data.parser_config,
      });
      setShowForm(true);
    } catch (err: any) {
      setFormError('Không thể phân tích URL: ' + err.message);
    } finally {
      setDetecting(false);
    }
  };

  const handleDetectKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleDetect();
    }
  };

  const selectFeed = (feedUrl: string, feedTitle: string) => {
    setFormData({
      ...formData,
      type: 'rss',
      url: feedUrl,
      name: feedTitle || formData.name,
      parser_config: undefined,
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setFormError('');
    try {
      if (editingId) {
        await api.updateSource(editingId, formData);
      } else {
        await api.createSource(formData);
      }
      setFormData({ type: 'rss', name: '', url: '', language: 'vi', category: '', fetch_interval_minutes: 60, parser_config: undefined, feed_category: 'news' });
      setEditingId(null);
      setShowForm(false);
      setDetectUrl('');
      setDetectResult(null);
      reload();
    } catch (err: any) {
      setFormError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleEdit = (source: any) => {
    setFormData({
      type: source.type,
      name: source.name,
      url: source.url,
      language: source.language,
      category: source.category || '',
      fetch_interval_minutes: source.fetch_interval_minutes || 60,
      parser_config: source.parser_config,
      feed_category: (source.feed_category === 'tech' ? 'tech' : 'news'),
    });
    setEditingId(source.id);
    setShowForm(true);
    setDetectResult(null);
    setDetectUrl('');
    // Cuộn lên đầu trang
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`Xóa nguồn "${name}"?`)) return;
    try {
      await api.deleteSource(id);
      reload();
    } catch (err: any) {
      alert('Lỗi: ' + err.message);
    }
  };

  const handleToggle = async (id: string) => {
    try {
      await api.toggleSource(id);
      reload();
    } catch (err: any) {
      alert('Lỗi: ' + err.message);
    }
  };

  const handleScrape = async (id: string) => {
    setScrapingId(id);
    try {
      const res = await api.scrapeSource(id);
      const data = res.data;
      if (data.status === 'queued' || data.status === 'already_running') {
        showToast(data.message || 'Đang cào ngầm...');
      } else {
        showToast(`Cào xong: ${data.itemsInserted}/${data.itemsFound} mục mới${data.status === 'partial' ? ' (có lỗi)' : ''}`);
      }
      reload();
    } catch (err: any) {
      showToast('Lỗi cào nguồn: ' + err.message, true);
      reload();
    } finally {
      setScrapingId(null);
    }
  };

  const handleChangeCategory = async (id: string, feed_category: 'news' | 'tech') => {
    try {
      await api.updateSource(id, { feed_category });
      reload();
    } catch (err: any) {
      alert('Lỗi: ' + err.message);
    }
  };

  const isSpecialSource = (source: any) => {
    const url = (source.url || '').toLowerCase();
    const name = (source.name || '').toLowerCase();
    return name.includes('voz') || url.includes('voz.vn') || name.includes('reddit') || url.includes('reddit.com');
  };

  if (loading) return <div className="loading">Đang tải...</div>;
  if (error) return <div className="loading" style={{ color: 'var(--color-error)' }}>Lỗi: {error}</div>;

  return (
    <div className="sources-page-container">
      {toast && (
        <div className={`source-toast ${toast.isError ? 'source-toast-error' : ''}`}>
          {toast.message}
        </div>
      )}
      <div className="page-header">
        <h1 className="page-title">Nguồn tin ({sourceList.length})</h1>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginBottom: 8 }}>Thêm nguồn tin</h3>
        <p style={{ fontSize: '0.85rem', color: 'var(--color-text-muted)', marginBottom: 12 }}>
          Dán link trang web, RSS feed, Reddit hoặc VOZ, hệ thống sẽ tự động phân tích.
        </p>
        <div className="detect-input-group">
          <input
            type="url"
            value={detectUrl}
            onChange={(e) => setDetectUrl(e.target.value)}
            onKeyDown={handleDetectKeyDown}
            placeholder="Dán link vào đây..."
            className="detect-input"
          />
          <button className="btn btn-primary" onClick={handleDetect} disabled={detecting || !detectUrl.trim()}>
            {detecting ? 'Đang phân tích...' : 'Phân tích'}
          </button>
        </div>

        {formError && !showForm && (
          <div style={{ color: 'var(--color-error)', marginTop: 8, fontSize: '0.875rem' }}>{formError}</div>
        )}

        {detectResult && (
          <div style={{ marginTop: 12, padding: 12, background: 'var(--color-bg)', borderRadius: 'var(--radius)', border: '1px solid var(--color-border)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <span className={`badge badge-${detectResult.type}`}>{detectResult.type.toUpperCase()}</span>
              <strong>{detectResult.name}</strong>
            </div>

            {detectResult.preview?.description && (
              <p style={{ fontSize: '0.85rem', color: 'var(--color-text-muted)', marginBottom: 8 }}>
                {detectResult.preview.description.substring(0, 200)}
              </p>
            )}

            {detectResult.supported === false && detectResult.warnings?.length > 0 && (
              <div style={{ color: 'var(--color-error)', fontSize: '0.85rem', marginBottom: 8 }}>
                {detectResult.warnings[0]}
              </div>
            )}

            {detectResult.rss_feeds && detectResult.rss_feeds.length > 0 && (
              <div style={{ marginBottom: 8 }}>
                <div style={{ fontSize: '0.85rem', fontWeight: 600, marginBottom: 4 }}>
                  Tìm thấy {detectResult.rss_feeds.length} RSS feed:
                </div>
                {detectResult.rss_feeds.map((feed: any, i: number) => (
                  <div key={i} style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '6px 8px', marginBottom: 4,
                    background: 'var(--color-bg-card)', borderRadius: 4, fontSize: '0.85rem',
                  }}>
                    <span style={{ flex: 1, wordBreak: 'break-all' }}>
                      <strong>{feed.title}</strong>
                      <br />
                      <span style={{ color: 'var(--color-text-muted)' }}>{feed.url}</span>
                    </span>
                    <button className="btn btn-sm btn-primary" onClick={() => selectFeed(feed.url, feed.title)}>
                      Chọn
                    </button>
                  </div>
                ))}
              </div>
            )}

            {detectResult.preview?.sample_items && (
              <div style={{ fontSize: '0.8rem', color: 'var(--color-text-muted)' }}>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>Bài viết mẫu:</div>
                {detectResult.preview.sample_items.map((item: any, i: number) => (
                  <div key={i} style={{ marginBottom: 2 }}>
                    {i + 1}. {item.title}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {showForm && (
        <form className="card" style={{ marginBottom: 16 }} onSubmit={handleSubmit}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <h3>{editingId ? 'Sửa nguồn tin' : 'Chi tiết nguồn tin'}</h3>
            <button type="button" className="btn btn-sm" onClick={() => { setShowForm(false); setDetectResult(null); setEditingId(null); }}>
              Hủy
            </button>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div className="form-group">
              <label>Loại</label>
              <select value={formData.type} onChange={(e) => setFormData({ ...formData, type: e.target.value })}>
                <option value="rss">RSS Feed</option>
                <option value="web">Web Scraping</option>
              </select>
            </div>
            <div className="form-group">
              <label>Ngôn ngữ</label>
              <select value={formData.language} onChange={(e) => setFormData({ ...formData, language: e.target.value })}>
                <option value="vi">Tiếng Việt</option>
                <option value="en">English</option>
                <option value="ja">Japanese</option>
                <option value="zh">Chinese</option>
                <option value="ko">Korean</option>
              </select>
            </div>
          </div>

          <div className="form-group">
            <label>Danh mục feed</label>
            <select
              value={formData.feed_category}
              onChange={(e) => setFormData({ ...formData, feed_category: e.target.value as 'news' | 'tech' })}
            >
              <option value="news">News (tin tức chung)</option>
              <option value="tech">Tech News (công nghệ)</option>
            </select>
            <div style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', marginTop: 4 }}>
              Chỉ áp dụng cho nguồn không phải VOZ/Reddit (chúng tự động gom về tab riêng).
            </div>
          </div>

          <div className="form-group">
            <label>Tên nguồn *</label>
            <input type="text" required value={formData.name}
              placeholder="VD: VnExpress, TechCrunch..."
              onChange={(e) => setFormData({ ...formData, name: e.target.value })} />
          </div>

          <div className="form-group">
            <label>URL *</label>
            <input type="url" required value={formData.url}
              placeholder="VD: https://vnexpress.net/rss/tin-moi-nhat.rss"
              onChange={(e) => setFormData({ ...formData, url: e.target.value })} />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div className="form-group">
              <label>Danh mục</label>
              <input type="text" value={formData.category}
                placeholder="VD: cong-nghe, kinh-te, the-gioi..."
                onChange={(e) => setFormData({ ...formData, category: e.target.value })} />
            </div>
            <div className="form-group" style={{ display: 'none' }}>
              <label>Tần suất lấy tin (phút)</label>
              <input type="number" min="30" value={formData.fetch_interval_minutes}
                onChange={(e) => setFormData({ ...formData, fetch_interval_minutes: parseInt(e.target.value) || 60 })} />
            </div>
          </div>

          {formError && <div style={{ color: 'var(--color-error)', marginBottom: 12, fontSize: '0.875rem' }}>{formError}</div>}

          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? 'Đang lưu...' : editingId ? 'Cập nhật nguồn tin' : 'Thêm nguồn tin'}
          </button>
        </form>
      )}

      <div className="sources-grid">
        {sourceList.length === 0 ? (
          <div className="empty-state">Chưa có nguồn tin nào. Dán link vào ô trên để bắt đầu.</div>
        ) : (
          sourceList.map((source: any) => (
            <div key={source.id} className="card source-item">
              <div className="source-info">
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
                  <span className={`badge badge-${source.type}`}>{source.type.toUpperCase()}</span>
                  <span className="source-name">{source.name}</span>
                  {!source.is_enabled && <span className="badge badge-error">Tắt</span>}
                  {source.consecutive_failures > 0 && (
                    <span className="badge badge-error">{source.consecutive_failures} lỗi</span>
                  )}
                  {!isSpecialSource(source) && (
                    <select
                      value={source.feed_category || 'news'}
                      onChange={(e) => handleChangeCategory(source.id, e.target.value as 'news' | 'tech')}
                      style={{
                        fontSize: '0.7rem',
                        padding: '2px 6px',
                        border: '1px solid var(--color-border)',
                        borderRadius: 4,
                        background: 'var(--color-bg)',
                        color: 'var(--color-text)',
                      }}
                      title="Xếp vào tab News hoặc Tech News"
                    >
                      <option value="news">News</option>
                      <option value="tech">Tech</option>
                    </select>
                  )}
                </div>
                <div className="source-url">{source.url}</div>
                <div style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', marginTop: 4 }}>
                  {source.language} | {source.category || 'Chưa phân loại'} | Mỗi {source.fetch_interval_minutes} phút
                  {source.last_success_at && ` | Thành công: ${new Date(source.last_success_at).toLocaleString('vi-VN')}`}
                  {` | Lần tới: ${formatNextRun(source.next_run_at)}`}
                </div>
                {source.last_error_message && (
                  <div style={{ fontSize: '0.75rem', color: 'var(--color-error)', marginTop: 2 }}>
                    Lỗi: {source.last_error_message}
                  </div>
                )}
              </div>
              <div className="source-actions">
                <label className="toggle">
                  <input type="checkbox" checked={source.is_enabled} onChange={() => handleToggle(source.id)} />
                  <span className="slider"></span>
                </label>
                <button className="btn btn-sm" onClick={() => handleScrape(source.id)} disabled={!source.is_enabled || scrapingId === source.id}>
                  {scrapingId === source.id ? 'Đang cào...' : 'Cào ngay'}
                </button>
                <button className="btn btn-sm" onClick={() => handleEdit(source)}>
                  Sửa
                </button>
                <button className="btn btn-sm btn-danger" onClick={() => handleDelete(source.id, source.name)}>
                  Xóa
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { api } from '../../services/api';
import { useFetch } from '../../hooks/useApi';
import { PromptConfigFormData, buildPromptConfigPayload, getPromptConfigWarnings, joinLines } from './adminHelpers';

export function PromptConfigTab() {
  const { data: config, loading, error, reload } = useFetch<any>(() => api.getPromptConfig());
  const [formData, setFormData] = useState<PromptConfigFormData>({
    output_language: '',
    topic_priorities: '',
    allowed_tags: '',
    digest_headings: '',
    custom_context: '',
  });
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState('');
  const [showPreview, setShowPreview] = useState(false);
  const warnings = getPromptConfigWarnings(formData);
  const previewPayload = buildPromptConfigPayload(formData);

  useEffect(() => {
    if (!config) return;
    setFormData({
      output_language: config.output_language || '',
      topic_priorities: joinLines(config.topic_priorities),
      allowed_tags: joinLines(config.allowed_tags),
      digest_headings: joinLines(config.digest_headings),
      custom_context: config.custom_context || '',
    });
  }, [config]);

  const handleSubmit: React.FormEventHandler<HTMLFormElement> = async (e) => {
    e.preventDefault();
    setSaving(true);
    setSaveMessage('');
    try {
      await api.updatePromptConfig(previewPayload);
      setSaveMessage('Đã lưu cấu hình prompt.');
      reload();
    } catch (err: any) {
      setSaveMessage(`Lỗi: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  const applyDefaultConfig = async () => {
    setSaving(true);
    setSaveMessage('');
    try {
      const result = await api.getDefaultPromptConfig();
      const defaultConfig = result.data;
      setFormData({
        output_language: defaultConfig.output_language || '',
        topic_priorities: joinLines(defaultConfig.topic_priorities),
        allowed_tags: joinLines(defaultConfig.allowed_tags),
        digest_headings: joinLines(defaultConfig.digest_headings),
        custom_context: defaultConfig.custom_context || '',
      });
      setSaveMessage('Đã nạp cấu hình mặc định, bấm Lưu nếu muốn áp dụng.');
    } catch (err: any) {
      setSaveMessage(`Lỗi: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  const resetDefaultConfig = async () => {
    if (!confirm('Đưa cấu hình prompt về mặc định?')) return;
    setSaving(true);
    setSaveMessage('');
    try {
      const result = await api.resetPromptConfig();
      const resetConfig = result.data;
      setFormData({
        output_language: resetConfig.output_language || '',
        topic_priorities: joinLines(resetConfig.topic_priorities),
        allowed_tags: joinLines(resetConfig.allowed_tags),
        digest_headings: joinLines(resetConfig.digest_headings),
        custom_context: resetConfig.custom_context || '',
      });
      setSaveMessage('Đã reset prompt config về mặc định.');
      reload();
    } catch (err: any) {
      setSaveMessage(`Lỗi: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="loading">Đang tải...</div>;
  if (error) return <div className="empty-state" style={{ color: 'var(--color-error)' }}>{error}</div>;

  return (
    <form className="card" onSubmit={handleSubmit}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap', marginBottom: 12 }}>
        <div>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>Cấu hình prompt</div>
          <div style={{ fontSize: '0.82rem', color: 'var(--color-text-muted)' }}>
            Cấu hình này áp dụng cho bài dịch mới và digest mới. Mỗi dòng là một giá trị.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-sm" onClick={() => setShowPreview(value => !value)}>
            {showPreview ? 'Ẩn preview' : 'Xem trước JSON'}
          </button>
          <button type="button" className="btn btn-sm" onClick={applyDefaultConfig} disabled={saving}>Nạp mặc định</button>
          <button type="button" className="btn btn-sm btn-danger" onClick={resetDefaultConfig} disabled={saving}>Đưa về mặc định</button>
        </div>
      </div>

      {warnings.length > 0 && (
        <div style={{ marginBottom: 12, padding: 10, border: '1px solid var(--color-warning)', borderRadius: 6, color: 'var(--color-warning)', fontSize: '0.82rem' }}>
          {warnings.map((warning) => <div key={warning}>{warning}</div>)}
        </div>
      )}

      {showPreview && (
        <pre style={{ marginBottom: 12, padding: 12, border: '1px solid var(--color-border)', borderRadius: 6, background: 'var(--color-bg)', color: 'var(--color-text)', overflowX: 'auto', fontSize: '0.78rem' }}>
          {JSON.stringify(previewPayload, null, 2)}
        </pre>
      )}

      <div className="form-group">
        <label>Ngôn ngữ output</label>
        <input
          type="text"
          value={formData.output_language}
          placeholder="Vietnamese"
          onChange={(e) => setFormData({ ...formData, output_language: e.target.value })}
        />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
        <div className="form-group">
          <label>Chủ đề ưu tiên</label>
          <textarea
            rows={7}
            value={formData.topic_priorities}
            onChange={(e) => setFormData({ ...formData, topic_priorities: e.target.value })}
          />
        </div>
        <div className="form-group">
          <label>Nhãn được phép</label>
          <textarea
            rows={7}
            value={formData.allowed_tags}
            onChange={(e) => setFormData({ ...formData, allowed_tags: e.target.value })}
          />
        </div>
      </div>

      <div className="form-group">
        <label>Nhóm tiêu đề bản tin</label>
        <textarea
          rows={5}
          value={formData.digest_headings}
          onChange={(e) => setFormData({ ...formData, digest_headings: e.target.value })}
        />
      </div>

      <div className="form-group">
        <label>Ngữ cảnh bổ sung</label>
        <textarea
          rows={5}
          value={formData.custom_context}
          placeholder="Không dùng XML tags hoặc markup đặc biệt."
          onChange={(e) => setFormData({ ...formData, custom_context: e.target.value })}
        />
      </div>

      {saveMessage && (
        <div style={{ marginBottom: 12, fontSize: '0.85rem', color: saveMessage.startsWith('Lỗi') ? 'var(--color-error)' : 'var(--color-success)' }}>
          {saveMessage}
        </div>
      )}

      <button type="submit" className="btn btn-primary" disabled={saving}>
        {saving ? 'Đang lưu...' : 'Lưu prompt config'}
      </button>
    </form>
  );
}


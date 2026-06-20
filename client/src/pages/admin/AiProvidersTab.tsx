import { useEffect, useState } from 'react';
import { api } from '../../services/api';
import { useFetch } from '../../hooks/useApi';
import { AI_PROVIDER_PRESETS, AI_PROVIDER_TYPES, AiProviderFormData, aiProviderHelp, createEmptyAiProviderForm, formatExtraConfig } from './adminHelpers';

export function AiProvidersTab() {
  const { data: providers, loading, reload } = useFetch<any[]>(() => api.getAiProviders());
  const { data: routing, reload: reloadRouting } = useFetch<any>(() => api.getAiProviderRouting());
  const [testResult, setTestResult] = useState<Record<string, string>>({});
  const [testing, setTesting] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [loadingDetails, setLoadingDetails] = useState(false);
  const [formError, setFormError] = useState('');
  const [formData, setFormData] = useState<AiProviderFormData>(() => createEmptyAiProviderForm());
  const [hasExistingApiKey, setHasExistingApiKey] = useState(false);
  const [clearApiKey, setClearApiKey] = useState(false);
  const [savingRouting, setSavingRouting] = useState(false);
  const [routingMessage, setRoutingMessage] = useState('');
  const [primaryProviderId, setPrimaryProviderId] = useState('');
  const [fallbackProviderId, setFallbackProviderId] = useState('');
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [fetchingModels, setFetchingModels] = useState(false);

  useEffect(() => {
    setPrimaryProviderId(routing?.primary_provider_id || providers?.find((p: any) => p.is_active)?.id || '');
    setFallbackProviderId(routing?.fallback_provider_id || '');
  }, [routing, providers]);

  const resetForm = () => {
    setFormData(createEmptyAiProviderForm());
    setEditingId(null);
    setShowForm(false);
    setFormError('');
    setLoadingDetails(false);
    setHasExistingApiKey(false);
    setClearApiKey(false);
    setAvailableModels([]);
  };

  const openCreateForm = () => {
    setFormData(createEmptyAiProviderForm());
    setEditingId(null);
    setFormError('');
    setHasExistingApiKey(false);
    setClearApiKey(false);
    setAvailableModels([]);
    setShowForm(true);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const applyPreset = (preset: typeof AI_PROVIDER_PRESETS[number]) => {
    setFormData(prev => ({ ...prev, ...preset.data }));
    setAvailableModels([]);
  };

  const handleProviderTypeChange = (type: string) => {
    const update: Partial<AiProviderFormData> = { provider_type: type };
    if (type === 'cliproxyapi') {
      if (!formData.api_endpoint || formData.api_endpoint === 'http://host.docker.internal:20128/v1') {
        update.api_endpoint = 'https://cli.tam1012.site/v1';
      }
      update.extra_config = '';
      update.max_tokens = 65536;
    }
    setFormData(prev => ({ ...prev, ...update }));
    setAvailableModels([]);
  };

  const handleFetchModels = async () => {
    setFetchingModels(true);
    setFormError('');
    try {
      let result;
      if (editingId) {
        result = await api.getAiProviderModels(editingId);
      } else {
        if (!formData.api_endpoint) {
          throw new Error('Chưa có endpoint');
        }
        result = await api.fetchAiProviderModels({
          api_endpoint: formData.api_endpoint,
          api_key: formData.api_key,
        });
      }
      const models = (result.data || []).map((m: any) => m.id).filter(Boolean).sort();
      if (models.length === 0) {
        setFormError('Không tìm thấy model nào từ endpoint này.');
      }
      setAvailableModels(models);
    } catch (err: any) {
      setFormError('Không lấy được danh sách model: ' + err.message);
    } finally {
      setFetchingModels(false);
    }
  };

  const handleSaveRouting = async () => {
    setSavingRouting(true);
    setRoutingMessage('');
    try {
      await api.updateAiProviderRouting({
        primary_provider_id: primaryProviderId || null,
        fallback_provider_id: fallbackProviderId || null,
      });
      setRoutingMessage('Đã lưu cấu hình AI fallback');
      reload();
      reloadRouting();
    } catch (err: any) {
      setRoutingMessage('Lỗi: ' + err.message);
    } finally {
      setSavingRouting(false);
    }
  };

  const handleActivate = async (id: string) => {
    try {
      await api.activateAiProvider(id);
      reload();
      reloadRouting();
    } catch (err: any) {
      alert('Lỗi: ' + err.message);
    }
  };

  const handleTest = async (id: string) => {
    setTesting(id);
    try {
      const result = await api.testAiProvider(id);
      setTestResult(prev => ({ ...prev, [id]: `Thành công: ${result.data?.response?.substring(0, 100) || 'OK'}` }));
    } catch (err: any) {
      setTestResult(prev => ({ ...prev, [id]: `Lỗi: ${err.message}` }));
    } finally {
      setTesting('');
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Xóa nhà cung cấp AI này?')) return;
    try {
      await api.deleteAiProvider(id);
      reload();
    } catch (err: any) {
      alert('Lỗi: ' + err.message);
    }
  };

  const handleEdit = async (id: string) => {
    setLoadingDetails(true);
    setFormError('');
    setShowForm(true);
    setEditingId(id);
    setAvailableModels([]);
    window.scrollTo({ top: 0, behavior: 'smooth' });

    try {
      const result = await api.getAiProvider(id);
      const provider = result.data;
      setFormData({
        name: provider.name || '',
        provider_type: provider.provider_type || 'custom',
        model: provider.model || '',
        api_endpoint: provider.api_endpoint || '',
        api_key: '',
        max_tokens: provider.max_tokens || 4096,
        temperature: provider.temperature !== undefined && provider.temperature !== null ? String(provider.temperature) : '0.3',
        extra_config: formatExtraConfig(provider.extra_config),
      });
      setHasExistingApiKey(Boolean(provider.has_api_key));
      setClearApiKey(false);
    } catch (err: any) {
      setFormError(err.message);
    } finally {
      setLoadingDetails(false);
    }
  };

  const handleSubmit: React.FormEventHandler<HTMLFormElement> = async (e) => {
    e.preventDefault();
    setSaving(true);
    setFormError('');

    try {
      let parsedExtraConfig: any = undefined;
      const extraConfigText = formData.extra_config.trim();
      if (extraConfigText) {
        parsedExtraConfig = JSON.parse(extraConfigText);
      }

      const payload: Record<string, any> = {
        name: formData.name.trim(),
        provider_type: formData.provider_type,
        model: formData.model.trim(),
        api_endpoint: formData.api_endpoint.trim() || null,
        max_tokens: Number(formData.max_tokens) || 4096,
        temperature: formData.temperature.trim() === '' ? 0.3 : Number(formData.temperature),
        extra_config: parsedExtraConfig,
      };

      if (Number.isNaN(payload.temperature)) {
        throw new Error('Độ sáng tạo phải là số hợp lệ');
      }

      if (editingId) {
        if (formData.api_key.trim()) {
          payload.api_key = formData.api_key.trim();
        } else if (clearApiKey) {
          payload.api_key = '';
        }

        await api.updateAiProvider(editingId, payload);
      } else {
        payload.api_key = formData.api_key.trim() || null;
        await api.createAiProvider(payload);
      }

      resetForm();
      reload();
    } catch (err: any) {
      setFormError(err.message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="loading">Đang tải...</div>;

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div className="card" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontWeight: 600 }}>Quản lý nhà cung cấp AI</div>
          <div style={{ fontSize: '0.82rem', color: 'var(--color-text-muted)' }}>
            Chọn model chính, model dự phòng, đổi model và thử kết nối.
          </div>
        </div>
        <button className="btn btn-primary" onClick={openCreateForm}>Thêm nhà cung cấp AI</button>
      </div>

      <div className="card" style={{ display: 'grid', gap: 10 }}>
        <div>
          <div style={{ fontWeight: 600 }}>Cấu hình fallback</div>
          <div style={{ fontSize: '0.82rem', color: 'var(--color-text-muted)' }}>
            Luôn dùng model chính trước. Khi lỗi tạm thời như 429, timeout hoặc 5xx thì tự chuyển sang model dự phòng cho bài đó.
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 10, alignItems: 'end' }}>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label>Model chính</label>
            <select value={primaryProviderId} onChange={(e) => setPrimaryProviderId(e.target.value)}>
              <option value="">Dùng provider đang kích hoạt</option>
              {(providers || []).map((p: any) => (
                <option key={p.id} value={p.id}>{p.name} · {p.model}</option>
              ))}
            </select>
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label>Model dự phòng</label>
            <select value={fallbackProviderId} onChange={(e) => setFallbackProviderId(e.target.value)}>
              <option value="">Không dùng fallback</option>
              {(providers || []).map((p: any) => (
                <option key={p.id} value={p.id} disabled={p.id === primaryProviderId}>{p.name} · {p.model}</option>
              ))}
            </select>
          </div>
          <button className="btn btn-primary" onClick={handleSaveRouting} disabled={savingRouting || !providers?.length}>
            {savingRouting ? 'Đang lưu...' : 'Lưu'}
          </button>
        </div>
        {routingMessage && (
          <div style={{ fontSize: '0.82rem', color: routingMessage.startsWith('Lỗi') ? 'var(--color-error)' : 'var(--color-success)' }}>
            {routingMessage}
          </div>
        )}
      </div>

      {showForm && (
        <form className="card" onSubmit={handleSubmit}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
            <h3>{editingId ? 'Sửa nhà cung cấp AI' : 'Thêm nhà cung cấp AI'}</h3>
            <button type="button" className="btn btn-sm" onClick={resetForm}>
              Hủy
            </button>
          </div>

          {loadingDetails ? (
            <div className="loading">Đang tải chi tiết nhà cung cấp...</div>
          ) : (
            <>
              {!editingId && (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
                  {AI_PROVIDER_PRESETS.map(preset => (
                    <button key={preset.label} type="button" className="btn btn-sm" onClick={() => applyPreset(preset)}>
                      {preset.label}
                    </button>
                  ))}
                </div>
              )}

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div className="form-group">
                  <label>Tên nhà cung cấp *</label>
                  <input
                    type="text"
                    required
                    value={formData.name}
                    placeholder="VD: Vertex key chính, 9router backup..."
                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  />
                </div>
                <div className="form-group">
                  <label>Loại nhà cung cấp *</label>
                  <select value={formData.provider_type} onChange={(e) => handleProviderTypeChange(e.target.value)}>
                    {AI_PROVIDER_TYPES.map(type => (
                      <option key={type.value} value={type.value}>{type.label}</option>
                    ))}
                  </select>
                  <div style={{ marginTop: 6, fontSize: '0.78rem', color: 'var(--color-text-muted)' }}>
                    {aiProviderHelp(formData.provider_type)}
                  </div>
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div className="form-group">
                  <label>Model *</label>
                  <div style={{ display: 'flex', gap: 6 }}>
                    {availableModels.length > 0 ? (
                      <select
                        required
                        value={formData.model}
                        onChange={(e) => {
                          const model = e.target.value;
                          setFormData(prev => ({
                            ...prev,
                            model,
                            name: prev.name || model,
                          }));
                        }}
                        style={{ flex: 1 }}
                      >
                        <option value="">Chọn model...</option>
                        {availableModels.map(m => (
                          <option key={m} value={m}>{m}</option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type="text"
                        required
                        value={formData.model}
                        placeholder="VD: gemini-3-flash-preview, vx/gemini-3-flash-preview..."
                        onChange={(e) => setFormData({ ...formData, model: e.target.value })}
                        style={{ flex: 1 }}
                      />
                    )}
                    {formData.api_endpoint && (
                      <button type="button" className="btn btn-sm" onClick={handleFetchModels} disabled={fetchingModels} style={{ whiteSpace: 'nowrap' }}>
                        {fetchingModels ? '...' : availableModels.length > 0 ? 'Tải lại' : 'Lấy model'}
                      </button>
                    )}
                  </div>
                  {availableModels.length > 0 && (
                    <div style={{ marginTop: 4, fontSize: '0.75rem', color: 'var(--color-text-muted)' }}>
                      {availableModels.length} model khả dụng
                    </div>
                  )}
                </div>
                <div className="form-group">
                  <label>API endpoint</label>
                  <input
                    type="text"
                    value={formData.api_endpoint}
                    placeholder="Để trống nếu dùng endpoint mặc định"
                    onChange={(e) => setFormData({ ...formData, api_endpoint: e.target.value })}
                  />
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div className="form-group">
                  <label>{editingId ? 'API key mới' : 'API key'}</label>
                  <input
                    type="password"
                    value={formData.api_key}
                    placeholder={editingId ? 'Để trống để giữ nguyên key hiện tại' : 'Nhập API key nếu dịch vụ cần'}
                    onChange={(e) => {
                      setFormData({ ...formData, api_key: e.target.value });
                      if (e.target.value) setClearApiKey(false);
                    }}
                  />
                  {editingId && hasExistingApiKey && (
                    <div style={{ marginTop: 6, fontSize: '0.78rem', color: 'var(--color-text-muted)' }}>
                      Nhà cung cấp này đang có API key lưu sẵn.
                    </div>
                  )}
                  {editingId && hasExistingApiKey && (
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, fontSize: '0.82rem' }}>
                      <input
                        type="checkbox"
                        checked={clearApiKey}
                        onChange={(e) => {
                          setClearApiKey(e.target.checked);
                          if (e.target.checked) {
                            setFormData({ ...formData, api_key: '' });
                          }
                        }}
                      />
                      Xóa API key hiện tại
                    </label>
                  )}
                </div>
                <div className="form-group">
                  <label>Cần điền</label>
                  <div style={{ padding: '10px 12px', border: '1px solid var(--color-border-light)', borderRadius: 6, fontSize: '0.82rem', color: 'var(--color-text-muted)' }}>
                    {formData.provider_type === 'cliproxyapi' && 'CLIProxyAPI: nhập API key (cpa-xxx), bấm "Lấy model" rồi chọn model.'}
                    {formData.provider_type === 'custom' && '9router VPS: model. Custom ngoài: API key, model, API endpoint.'}
                    {formData.provider_type === 'anthropic' && 'API key, model, API endpoint nếu không dùng endpoint mặc định.'}
                    {formData.provider_type === 'vertex_ai_key' && 'Vertex AI API key và model Gemini.'}
                    {formData.provider_type === 'openai_responses' && 'OpenAI API key và model Responses.'}
                  </div>
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div className="form-group">
                  <label>Số token tối đa</label>
                  <input
                    type="number"
                    min="1"
                    value={formData.max_tokens}
                    onChange={(e) => setFormData({ ...formData, max_tokens: parseInt(e.target.value, 10) || 4096 })}
                  />
                </div>
                <div className="form-group">
                  <label>Độ sáng tạo</label>
                  <input
                    type="number"
                    min="0"
                    max="2"
                    step="0.1"
                    value={formData.temperature}
                    onChange={(e) => setFormData({ ...formData, temperature: e.target.value })}
                  />
                </div>
              </div>

              <div className="form-group">
                <label>Cấu hình thêm (JSON)</label>
                <textarea
                  rows={6}
                  value={formData.extra_config}
                  placeholder='Ví dụ: {"reasoning_effort":"medium"}'
                  onChange={(e) => setFormData({ ...formData, extra_config: e.target.value })}
                />
              </div>

              {formError && <div style={{ color: 'var(--color-error)', marginBottom: 12, fontSize: '0.875rem' }}>{formError}</div>}

              <button type="submit" className="btn btn-primary" disabled={saving}>
                {saving ? 'Đang lưu...' : editingId ? 'Cập nhật nhà cung cấp AI' : 'Thêm nhà cung cấp AI'}
              </button>
            </>
          )}
        </form>
      )}

      {(providers || []).map((p: any) => (
        <div key={p.id} className="card">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontWeight: 600 }}>
                {p.name}
                {p.id === primaryProviderId && <span className="badge badge-success" style={{ marginLeft: 6 }}>Chính</span>}
                {p.id === fallbackProviderId && <span className="badge badge-pending" style={{ marginLeft: 6 }}>Dự phòng</span>}
              </div>
              <div style={{ fontSize: '0.78rem', color: 'var(--color-text-muted)' }}>
                {p.provider_type} · {p.model} · {p.total_calls} lượt gọi
              </div>
              {p.last_error_message && (
                <div style={{ fontSize: '0.75rem', color: 'var(--color-error)', marginTop: 2 }}>
                  {p.last_error_message.substring(0, 80)}
                </div>
              )}
              {testResult[p.id] && (
                <div style={{ fontSize: '0.75rem', marginTop: 4 }}>{testResult[p.id]}</div>
              )}
            </div>
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {!p.is_active && (
                <button className="btn btn-sm btn-primary" onClick={() => handleActivate(p.id)}>Kích hoạt</button>
              )}
              <button className="btn btn-sm" onClick={() => handleEdit(p.id)} disabled={loadingDetails && editingId === p.id}>
                {loadingDetails && editingId === p.id ? '...' : 'Sửa'}
              </button>
              <button className="btn btn-sm" onClick={() => handleTest(p.id)} disabled={testing === p.id}>
                {testing === p.id ? '...' : 'Thử'}
              </button>
              <button className="btn btn-sm btn-danger" onClick={() => handleDelete(p.id)}>Xóa</button>
            </div>
          </div>
        </div>
      ))}

      {(!providers || providers.length === 0) && (
        <div className="empty-state"><p>Chưa có nhà cung cấp AI nào.</p></div>
      )}
    </div>
  );
}


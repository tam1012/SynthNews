import { useState, useEffect, useCallback, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, clearAdminToken, getAdminToken, setAdminToken } from '../services/api';
import { useFetch } from '../hooks/useApi';
import { AiProvidersTab } from './admin/AiProvidersTab';
import { FetchJobsTab } from './admin/FetchJobsTab';
import { OverviewTab, type AdminActionMessage } from './admin/OverviewTab';
import { StatsTab } from './admin/StatsTab';
import { PromptConfigTab } from './admin/PromptConfigTab';
import { QualityControlTab } from './admin/QualityControlTab';
import { SummaryQueueTab } from './admin/SummaryQueueTab';
import { BlocklistTab } from './admin/BlocklistTab';
import { AdminHealth, AdminTab, FetchJobStatus, SummaryQueueStatus } from './admin/adminHelpers';

const TAB_SLUGS: { tab: AdminTab; slug: string; label: string }[] = [
  { tab: 'overview', slug: 'overview', label: 'Tổng quan' },
  { tab: 'stats', slug: 'stats', label: 'Thống kê' },
  { tab: 'queue', slug: 'queue', label: 'Hàng đợi tóm tắt' },
  { tab: 'quality', slug: 'quality', label: 'Kiểm tra chất lượng' },
  { tab: 'fetchJobs', slug: 'fetch-jobs', label: 'Hàng đợi lấy bài' },
  { tab: 'ai', slug: 'ai', label: 'Nhà cung cấp AI' },
  { tab: 'prompt', slug: 'prompt', label: 'Cấu hình prompt' },
  { tab: 'blocklist', slug: 'blocklist', label: 'Danh sách chặn' },
];

const ADMIN_ACTION_SUCCESS_MESSAGES: Record<string, string> = {
  scrape: 'Đã gửi lệnh cào nguồn đến hạn. Số liệu sẽ cập nhật sau ít giây.',
  'fetch-articles': 'Đã gửi lệnh lấy nội dung bài. Số liệu sẽ cập nhật sau ít giây.',
  summarize: 'Đã gửi lệnh tóm tắt bài. Số liệu sẽ cập nhật sau ít giây.',
  digest: 'Đã gửi lệnh tạo bản tin. Số liệu sẽ cập nhật sau ít giây.',
};

type AdminAuthPanelProps = {
  tokenInput: string;
  message: string;
  error: string | null;
  onTokenInputChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
};

function slugToTab(slug?: string): AdminTab {
  if (!slug) return 'overview';
  const found = TAB_SLUGS.find(t => t.slug === slug);
  return found ? found.tab : 'overview';
}

function tabToSlug(tab: AdminTab): string {
  return TAB_SLUGS.find(t => t.tab === tab)?.slug || 'overview';
}

function isAdminAuthError(error: string | null): boolean {
  if (!error) return false;
  const normalized = error.toLowerCase();
  return normalized.includes('token') || normalized.includes('unauthorized') || normalized.includes('missing');
}

function AdminAuthPanel({ tokenInput, message, error, onTokenInputChange, onSubmit }: AdminAuthPanelProps) {
  return (
    <form className="admin-auth-panel" onSubmit={onSubmit}>
      <div>
        <h2>Cần token admin</h2>
        <p>Nhập token để mở các thao tác vận hành và dữ liệu nội bộ.</p>
      </div>
      <div className="admin-auth-row">
        <input
          type="password"
          value={tokenInput}
          onChange={(event) => onTokenInputChange(event.target.value)}
          placeholder="Admin token"
          autoComplete="current-password"
          aria-label="Admin token"
        />
        <button type="submit" className="btn btn-primary">
          Đăng nhập
        </button>
      </div>
      {(error || message) && (
        <div className={`admin-auth-message ${error ? 'is-error' : 'is-success'}`}>
          {error || message}
        </div>
      )}
    </form>
  );
}

export function Admin() {
  const navigate = useNavigate();
  const { tab: tabParam } = useParams<{ tab?: string }>();
  const initialTab = slugToTab(tabParam);

  const [adminToken, setAdminTokenState] = useState(() => getAdminToken());
  const [tokenInput, setTokenInput] = useState('');
  const [authMessage, setAuthMessage] = useState('');
  const [tab, setTab] = useState<AdminTab>(initialTab);
  const { data: health, loading, error, reload } = useFetch<AdminHealth>(
    () => adminToken ? api.getHealth() : Promise.reject(new Error('Cần token admin để xem trang quản trị.')),
    [adminToken]
  );
  const [actionLoading, setActionLoading] = useState('');
  const [actionMessage, setActionMessage] = useState<AdminActionMessage | null>(null);
  const [queueFilter, setQueueFilter] = useState<SummaryQueueStatus>('failed');
  const [fetchFilter, setFetchFilter] = useState<FetchJobStatus>('failed');

  // Keep state in sync with URL (sidebar navigation, back/forward)
  useEffect(() => {
    const next = slugToTab(tabParam);
    setTab(next);
  }, [tabParam]);

  const navigateToTab = useCallback((next: AdminTab) => {
    const slug = tabToSlug(next);
    const path = slug === 'overview' ? '/admin' : `/admin/${slug}`;
    navigate(path);
  }, [navigate]);

  const goToQueue = (status: SummaryQueueStatus) => {
    setQueueFilter(status);
    navigateToTab('queue');
  };
  const goToFetch = (status: FetchJobStatus) => {
    setFetchFilter(status);
    navigateToTab('fetchJobs');
  };
  const goToQuality = () => {
    navigateToTab('quality');
  };

  const handleLogin = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextToken = tokenInput.trim();
    if (!nextToken) {
      setAuthMessage('Token admin không được để trống.');
      return;
    }
    setAdminToken(nextToken);
    setAdminTokenState(nextToken);
    setTokenInput('');
    setAuthMessage('Đã lưu token admin. Đang tải lại trạng thái...');
    setActionMessage(null);
  };

  const handleLogout = () => {
    clearAdminToken();
    setAdminTokenState('');
    setTokenInput('');
    setAuthMessage('Đã đăng xuất khỏi admin.');
    setActionMessage(null);
  };

  const trigger = async (action: string, fn: () => Promise<unknown>) => {
    setActionLoading(action);
    setActionMessage({ type: 'pending', message: 'Đang gửi lệnh vận hành...' });
    try {
      await fn();
      const message = ADMIN_ACTION_SUCCESS_MESSAGES[action] || 'Đã gửi lệnh. Số liệu sẽ cập nhật sau ít giây.';
      setActionMessage({ type: 'success', message });
      reload();
      setTimeout(reload, 3000);
    } catch (err: unknown) {
      setActionMessage({ type: 'error', message: err instanceof Error ? err.message : 'Không gửi được lệnh vận hành.' });
    } finally {
      setActionLoading('');
    }
  };

  const authError = isAdminAuthError(error) ? error : null;
  const needsAuthPanel = !adminToken || Boolean(authError);

  return (
    <div className="admin-container">
      <div className="page-header admin-header">
        <h1 className="page-title">Quản trị hệ thống</h1>
        {adminToken && (
          <button className="btn btn-sm" onClick={handleLogout}>
            Đăng xuất
          </button>
        )}
      </div>

      {needsAuthPanel ? (
        <AdminAuthPanel
          tokenInput={tokenInput}
          message={authMessage}
          error={authError}
          onTokenInputChange={setTokenInput}
          onSubmit={handleLogin}
        />
      ) : (
        <>
      <div className="admin-tabs">
        {TAB_SLUGS.map(t => (
          <button
            key={t.tab}
            className={`btn btn-sm ${tab === t.tab ? 'btn-primary' : ''}`}
            onClick={() => navigateToTab(t.tab)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'overview' && (
        <OverviewTab
          health={health}
          loading={loading}
          error={error}
          reload={reload}
          trigger={trigger}
          actionLoading={actionLoading}
          actionMessage={actionMessage}
          goToQueue={goToQueue}
          goToFetch={goToFetch}
          goToQuality={goToQuality}
        />
      )}
      {tab === 'stats' && <StatsTab />}
      {tab === 'queue' && <SummaryQueueTab initialStatus={queueFilter} />}
      {tab === 'quality' && <QualityControlTab />}
      {tab === 'fetchJobs' && <FetchJobsTab initialStatus={fetchFilter} />}
      {tab === 'ai' && <AiProvidersTab />}
      {tab === 'prompt' && <PromptConfigTab />}
      {tab === 'blocklist' && <BlocklistTab />}
        </>
      )}

    </div>
  );
}

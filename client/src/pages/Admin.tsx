import { useState, useEffect, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../services/api';
import { useFetch } from '../hooks/useApi';
import { AiProvidersTab } from './admin/AiProvidersTab';
import { FetchJobsTab } from './admin/FetchJobsTab';
import { OverviewTab, type AdminActionMessage } from './admin/OverviewTab';
import { PromptConfigTab } from './admin/PromptConfigTab';
import { QualityControlTab } from './admin/QualityControlTab';
import { SummaryQueueTab } from './admin/SummaryQueueTab';
import { BlocklistTab } from './admin/BlocklistTab';
import { AdminHealth, AdminTab, FetchJobStatus, SummaryQueueStatus } from './admin/adminHelpers';

const TAB_SLUGS: { tab: AdminTab; slug: string; label: string }[] = [
  { tab: 'overview', slug: 'overview', label: 'Tổng quan' },
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

function slugToTab(slug?: string): AdminTab {
  if (!slug) return 'overview';
  const found = TAB_SLUGS.find(t => t.slug === slug);
  return found ? found.tab : 'overview';
}

function tabToSlug(tab: AdminTab): string {
  return TAB_SLUGS.find(t => t.tab === tab)?.slug || 'overview';
}

export function Admin() {
  const navigate = useNavigate();
  const { tab: tabParam } = useParams<{ tab?: string }>();
  const initialTab = slugToTab(tabParam);

  const [tab, setTab] = useState<AdminTab>(initialTab);
  const { data: health, loading, error, reload } = useFetch<AdminHealth>(() => api.getHealth());
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

  return (
    <div className="admin-container">
      <div className="page-header">
        <h1 className="page-title">Quản trị hệ thống</h1>
      </div>

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
      {tab === 'queue' && <SummaryQueueTab initialStatus={queueFilter} />}
      {tab === 'quality' && <QualityControlTab />}
      {tab === 'fetchJobs' && <FetchJobsTab initialStatus={fetchFilter} />}
      {tab === 'ai' && <AiProvidersTab />}
      {tab === 'prompt' && <PromptConfigTab />}
      {tab === 'blocklist' && <BlocklistTab />}

    </div>
  );
}

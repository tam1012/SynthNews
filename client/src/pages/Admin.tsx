import { useState } from 'react';
import { api } from '../services/api';
import { useFetch } from '../hooks/useApi';
import { AiProvidersTab } from './admin/AiProvidersTab';
import { FetchJobsTab } from './admin/FetchJobsTab';
import { OverviewTab } from './admin/OverviewTab';
import { PromptConfigTab } from './admin/PromptConfigTab';
import { QualityControlTab } from './admin/QualityControlTab';
import { SummaryQueueTab } from './admin/SummaryQueueTab';
import { BlocklistTab } from './admin/BlocklistTab';
import { AdminTab, FetchJobStatus, SummaryQueueStatus } from './admin/adminHelpers';

export function Admin() {
  const [tab, setTab] = useState<AdminTab>('overview');
  const { data: health, loading, error, reload } = useFetch<any>(() => api.getHealth());
  const [actionLoading, setActionLoading] = useState('');
  const [queueFilter, setQueueFilter] = useState<SummaryQueueStatus>('failed');
  const [fetchFilter, setFetchFilter] = useState<FetchJobStatus>('failed');

  const goToQueue = (status: SummaryQueueStatus) => {
    setQueueFilter(status);
    setTab('queue');
  };
  const goToFetch = (status: FetchJobStatus) => {
    setFetchFilter(status);
    setTab('fetchJobs');
  };
  const goToQuality = () => {
    setTab('quality');
  };

  const trigger = async (action: string, fn: () => Promise<any>) => {
    setActionLoading(action);
    try {
      await fn();
      setTimeout(reload, 3000);
    } catch (err: any) {
      alert('Lỗi: ' + err.message);
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
        {[
          { key: 'overview', label: 'Tổng quan' },
          { key: 'queue', label: 'Hàng đợi tóm tắt' },
          { key: 'quality', label: 'Kiểm tra chất lượng' },
          { key: 'fetchJobs', label: 'Hàng đợi lấy bài' },
          { key: 'ai', label: 'Nhà cung cấp AI' },
          { key: 'prompt', label: 'Cấu hình prompt' },
          { key: 'blocklist', label: 'Danh sách chặn' },
        ].map(t => (
          <button
            key={t.key}
            className={`btn btn-sm ${tab === t.key ? 'btn-primary' : ''}`}
            onClick={() => setTab(t.key as AdminTab)}
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


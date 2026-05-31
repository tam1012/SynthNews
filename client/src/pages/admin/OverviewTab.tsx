import { api } from '../../services/api';
import {
  AdminHealth,
  AdminScrapeLog,
  AdminSourceQuality,
  AdminWorkItem,
  FetchJobStatus,
  SummaryQueueStatus,
  buildAdminWorkItems,
  forumKindLabel,
  forumStatsValue,
  getBrowserProxySources,
  getPublicChecks,
  numberText,
  percentText,
  sourceQualityBadgeClass,
  sourceQualityLabel,
  sourceQualityNote,
  statusLabel,
} from './adminHelpers';

export type AdminActionMessage = {
  type: 'pending' | 'success' | 'error';
  message: string;
};

function formatBrowserCookieExpiry(label: string, expiresAt: string | null | undefined): string | null {
  if (!expiresAt) return null;
  const expiresMs = new Date(expiresAt).getTime();
  if (!Number.isFinite(expiresMs)) return null;
  const diffHours = Math.max(0, Math.round((expiresMs - Date.now()) / 3600000));
  return `Cookie ${label} dự kiến hết hạn lúc ${new Date(expiresAt).toLocaleString('vi-VN')} (${diffHours} giờ nữa).`;
}

function browserProxyInstruction(source: { id?: string; verifyUrl?: string }): string {
  const verifyUrl = source.verifyUrl || (source.id === 'reuters' ? 'https://www.reuters.com' : 'https://voz.vn');
  return `SSH/VNC vào VPS, mở Chromium đang bật remote debugging, truy cập ${verifyUrl} và vượt Cloudflare nếu có. Sau đó bấm “Tải lại số liệu”.`;
}

function formatUptime(seconds: unknown): string {
  const totalSeconds = Number(seconds || 0);
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return 'Mới khởi động';
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (days > 0) return `${days} ngày ${hours} giờ`;
  if (hours > 0) return `${hours} giờ ${minutes} phút`;
  return `${Math.max(1, minutes)} phút`;
}

function formatDateTime(value: unknown): string {
  if (!value) return 'Chưa có dữ liệu';
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('vi-VN');
}

const ADMIN_WORK_SEVERITY_LABELS: Record<string, string> = {
  critical: 'Khẩn cấp',
  warning: 'Cần xem',
  info: 'Theo dõi',
  ok: 'Ổn',
};

export function OverviewTab({
  health,
  loading,
  error,
  reload,
  trigger,
  actionLoading,
  actionMessage,
  goToQueue,
  goToFetch,
  goToQuality,
}: {
  health: AdminHealth | null | undefined;
  loading: boolean;
  error: string | null;
  reload: () => void;
  trigger: (action: string, fn: () => Promise<unknown>) => Promise<void>;
  actionLoading: string;
  actionMessage: AdminActionMessage | null;
  goToQueue: (status: SummaryQueueStatus) => void;
  goToFetch: (status: FetchJobStatus) => void;
  goToQuality: () => void;
}) {
  const browserProxySources = getBrowserProxySources(health);
  const publicChecks = getPublicChecks(health);
  const publicChecksOk = publicChecks.length > 0 && publicChecks.every((check) => check.status === 'ok');
  const scrapling = health?.scrapling;
  const deployLabel = health?.deploy?.shortCommit || health?.deploy?.commit?.slice?.(0, 7) || 'chưa rõ';
  const workItems = buildAdminWorkItems(health);

  const openWorkItemTarget = (item: AdminWorkItem) => {
    if (!item.target) return;
    if (item.target === 'sources') {
      window.location.href = '/sources';
    } else if (item.target === 'quality') {
      goToQuality();
    } else if (item.target.startsWith('queue:')) {
      goToQueue(item.target.replace('queue:', '') as SummaryQueueStatus);
    } else if (item.target.startsWith('fetch:')) {
      goToFetch(item.target.replace('fetch:', '') as FetchJobStatus);
    }
  };

  const runWorkItemAction = (item: AdminWorkItem) => {
    if (item.runAction === 'scrape') return trigger('scrape', api.triggerScrape);
    if (item.runAction === 'fetch-articles') return trigger('fetch-articles', api.triggerFetchArticles);
    if (item.runAction === 'summarize') return trigger('summarize', api.triggerSummarize);
    if (item.runAction === 'digest') return trigger('digest', api.triggerDigest);
    return Promise.resolve();
  };

  return (
        <div>
          {loading ? (
            <div className="loading">Đang tải...</div>
          ) : error ? (
            <div className="empty-state">
              <p style={{ color: 'var(--color-error)' }}>{error}</p>
              <button className="btn btn-primary" onClick={reload} style={{ marginTop: 12 }}>Nhập lại token</button>
            </div>
          ) : health ? (
            <div style={{ display: 'grid', gap: 12 }}>
              {actionMessage && (
                <div
                  className="admin-action-message"
                  style={{
                    padding: '10px 12px',
                    border: '1px solid var(--color-border-light)',
                    borderRadius: 8,
                    background: actionMessage.type === 'error'
                      ? 'rgba(239, 68, 68, 0.08)'
                      : actionMessage.type === 'success'
                        ? 'rgba(34, 197, 94, 0.08)'
                        : 'var(--color-bg-card)',
                    color: actionMessage.type === 'error'
                      ? 'var(--color-error)'
                      : actionMessage.type === 'success'
                        ? 'var(--color-success)'
                        : 'var(--color-text-secondary)',
                    fontSize: '0.86rem',
                    fontWeight: 700,
                  }}
                >
                  {actionMessage.message}
                </div>
              )}

              {browserProxySources.length > 0 && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12 }}>
                  {browserProxySources.map((source) => {
                    const label = source.label || source.id || 'Nguồn';
                    const remoteBrowserUrl = source.remoteBrowserUrl || health.browserProxy?.remoteBrowserUrl || health.vozProxy?.remoteBrowserUrl;
                    const expiryText = formatBrowserCookieExpiry(label, source.cookieExpiresAt);
                    const needsBrowser = Boolean(source.needsBrowser);
                    return (
                      <div key={source.id || label} className="card" style={{ borderColor: needsBrowser ? 'var(--color-error)' : 'var(--color-warning)', background: needsBrowser ? 'rgba(239, 68, 68, 0.08)' : 'rgba(245, 158, 11, 0.08)' }}>
                        <div style={{ fontWeight: needsBrowser ? 800 : 700, color: needsBrowser ? 'var(--color-error)' : undefined, marginBottom: 6 }}>
                          {needsBrowser ? `${label} cần mở Chromium trên VPS` : `${label} proxy đang hoạt động`}
                        </div>
                        <div style={{ fontSize: '0.86rem', color: needsBrowser ? 'var(--color-text)' : 'var(--color-text-muted)', marginBottom: 6 }}>
                          {source.message || `${label} proxy đang sẵn sàng.`}
                        </div>
                        <div style={{ fontSize: '0.78rem', color: 'var(--color-text-muted)', marginBottom: remoteBrowserUrl || needsBrowser ? 10 : 0 }}>
                          {needsBrowser
                            ? browserProxyInstruction(source)
                            : `${expiryText ? `${expiryText} ` : ''}Nếu ${label} lỗi antibot thì mở lại ${source.verifyUrl || label} trên Chromium VPS.`}
                        </div>
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                          {remoteBrowserUrl && (
                            <button className={`btn btn-sm ${needsBrowser ? 'btn-primary' : ''}`} onClick={() => window.open(remoteBrowserUrl, '_blank', 'noopener,noreferrer')}>
                              Mở trình duyệt VPS
                            </button>
                          )}
                          {needsBrowser && <button className="btn btn-sm" onClick={reload}>Tải lại số liệu</button>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              <div className="card">
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
                  <div>
                    <div style={{ fontWeight: 700 }}>Tình trạng hệ thống</div>
                    <div style={{ fontSize: '0.78rem', color: 'var(--color-text-muted)', marginTop: 2 }}>
                      Kiểm tra nhanh app đang chạy, database và public site.
                    </div>
                  </div>
                  <button className="btn btn-sm" onClick={reload}>Tải lại số liệu</button>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 8 }}>
                  <div style={{ padding: '10px 12px', border: '1px solid var(--color-border-light)', borderRadius: 8 }}>
                    <div style={{ fontSize: '0.72rem', color: 'var(--color-text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Đang chạy commit</div>
                    <div style={{ fontSize: '1.2rem', lineHeight: 1.2, fontWeight: 800, marginTop: 6 }}>{deployLabel}</div>
                    <div style={{ fontSize: '0.72rem', color: 'var(--color-text-muted)', marginTop: 4 }}>
                      {health.deploy?.branch ? `Branch ${health.deploy.branch}` : 'Chưa rõ branch'} · deploy {formatDateTime(health.deploy?.deployedAt)}
                    </div>
                  </div>
                  <div style={{ padding: '10px 12px', border: '1px solid var(--color-border-light)', borderRadius: 8 }}>
                    <div style={{ fontSize: '0.72rem', color: 'var(--color-text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Uptime app</div>
                    <div style={{ fontSize: '1.2rem', lineHeight: 1.2, fontWeight: 800, marginTop: 6 }}>{formatUptime(health.runtime?.uptimeSeconds)}</div>
                    <div style={{ fontSize: '0.72rem', color: 'var(--color-text-muted)', marginTop: 4 }}>
                      {health.runtime?.nodeEnv || 'development'} · {health.runtime?.containerName || 'container chưa rõ'}
                    </div>
                  </div>
                  <div style={{ padding: '10px 12px', border: '1px solid var(--color-border-light)', borderRadius: 8 }}>
                    <div style={{ fontSize: '0.72rem', color: 'var(--color-text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Database</div>
                    <div style={{ fontSize: '1.2rem', lineHeight: 1.2, fontWeight: 800, marginTop: 6, color: health.runtime?.dbReachable ? 'var(--color-success)' : 'var(--color-error)' }}>
                      {health.runtime?.dbReachable ? 'Kết nối được' : 'Đang lỗi'}
                    </div>
                    <div style={{ fontSize: '0.72rem', color: 'var(--color-text-muted)', marginTop: 4 }}>
                      Kiểm tra lúc {formatDateTime(health.runtime?.checkedAt || health.time)}
                    </div>
                  </div>
                  <div style={{ padding: '10px 12px', border: '1px solid var(--color-border-light)', borderRadius: 8 }}>
                    <div style={{ fontSize: '0.72rem', color: 'var(--color-text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Public site</div>
                    <div style={{ fontSize: '1.2rem', lineHeight: 1.2, fontWeight: 800, marginTop: 6, color: publicChecksOk ? 'var(--color-success)' : 'var(--color-warning)' }}>
                      {publicChecksOk ? 'Reachable' : 'Cần kiểm tra'}
                    </div>
                    <div style={{ display: 'grid', gap: 3, marginTop: 6 }}>
                      {publicChecks.length > 0 ? publicChecks.map((check) => (
                        <div key={check.key || check.url} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: '0.72rem', color: 'var(--color-text-muted)' }}>
                          <span>{check.label || check.key}</span>
                          <strong style={{ color: check.status === 'ok' ? 'var(--color-success)' : 'var(--color-error)' }}>
                            {check.status === 'ok' ? `${check.httpStatus || 200}` : 'Lỗi'}
                          </strong>
                        </div>
                      )) : (
                        <div style={{ fontSize: '0.72rem', color: 'var(--color-text-muted)' }}>Chưa có public check.</div>
                      )}
                    </div>
                  </div>
                  {scrapling?.configured && (
                    <div style={{ padding: '10px 12px', border: '1px solid var(--color-border-light)', borderRadius: 8 }}>
                      <div style={{ fontSize: '0.72rem', color: 'var(--color-text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Scrapling sidecar</div>
                      <div style={{ fontSize: '1.2rem', lineHeight: 1.2, fontWeight: 800, marginTop: 6, color: scrapling.ok ? 'var(--color-success)' : 'var(--color-error)' }}>
                        {scrapling.ok ? 'Sẵn sàng' : 'Đang lỗi'}
                      </div>
                      <div style={{ fontSize: '0.72rem', color: 'var(--color-text-muted)', marginTop: 4 }}>
                        {scrapling.ok
                          ? `Đang xử lý ${numberText(scrapling.inFlight)}/${numberText(scrapling.maxConcurrency)} · uptime ${formatUptime(scrapling.uptimeSeconds)}`
                          : (scrapling.message || 'Sidecar không phản hồi — VOZ/Reddit sẽ ngừng ra bài.')}
                      </div>
                    </div>
                  )}
                </div>
              </div>

              <div className="card" style={{ borderColor: workItems.some((item) => item.severity === 'critical') ? 'var(--color-warning)' : 'var(--color-border)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
                  <div>
                    <div style={{ fontWeight: 700 }}>Cần xử lý</div>
                    <div style={{ fontSize: '0.78rem', color: 'var(--color-text-muted)', marginTop: 2 }}>
                      Những mục này đáng xem trước nếu hệ thống chạy không như ý.
                    </div>
                  </div>
                  <button className="btn btn-sm" onClick={reload}>Tải lại số liệu</button>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 8 }}>
                  {workItems.map((item) => (
                    <div
                      key={item.label}
                      onClick={() => openWorkItemTarget(item)}
                      title={item.target ? 'Bấm để mở nơi xử lý chi tiết' : undefined}
                      style={{ padding: '10px 12px', border: '1px solid var(--color-border-light)', borderRadius: 8, cursor: item.target ? 'pointer' : 'default', transition: 'background 0.15s' }}
                      className={`admin-work-item admin-work-item-${item.severity} ${item.target ? 'admin-clickable-card' : ''}`}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start' }}>
                        <div style={{ fontSize: '1.45rem', lineHeight: 1, fontWeight: 800, color: item.severity === 'critical' ? 'var(--color-error)' : item.severity === 'warning' ? 'var(--color-warning)' : 'var(--color-text-muted)' }}>{item.value || 0}</div>
                        <span className={`badge badge-${item.severity === 'critical' ? 'error' : item.severity === 'warning' ? 'pending' : 'success'}`}>
                          Mức ưu tiên: {ADMIN_WORK_SEVERITY_LABELS[item.severity]}
                        </span>
                      </div>
                      <div style={{ fontSize: '0.82rem', fontWeight: 700, marginTop: 7 }}>{item.label}{item.target ? ' ›' : ''}</div>
                      <div style={{ fontSize: '0.72rem', color: 'var(--color-text-muted)', marginTop: 3 }}>{item.note}</div>
                      {item.runAction && (
                        <button
                          className="btn btn-sm"
                          onClick={(event) => {
                            event.stopPropagation();
                            void runWorkItemAction(item);
                          }}
                          disabled={!!actionLoading}
                          style={{ marginTop: 8 }}
                        >
                          {actionLoading === item.runAction ? 'Đang chạy...' : item.actionLabel || 'Chạy ngay'}
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12 }}>
                <div className="card admin-clickable-card" onClick={() => window.location.href = '/sources'} title="Mở trang Nguồn tin" style={{ cursor: 'pointer' }}>
                  <div style={{ fontWeight: 700, marginBottom: 10 }}>Tình trạng nguồn tin ›</div>
                  <div style={{ display: 'grid', gap: 8 }}>
                    {[
                      ['Tổng nguồn', health.sources?.total],
                      ['Đang bật', health.sources?.enabled],
                      ['Đến hạn cào', health.sources?.due],
                      ['Đang backoff', health.sources?.backed_off],
                      ['Nguồn ổn', health.sourceQualitySummary?.healthy],
                      ['Ít bài mới', health.sourceQualitySummary?.low_yield],
                    ].map(([label, value]) => (
                      <div key={String(label)} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: '0.86rem' }}>
                        <span style={{ color: 'var(--color-text-muted)' }}>{label}</span>
                        <strong>{value || 0}</strong>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="card">
                  <div style={{ fontWeight: 700, marginBottom: 10 }}>Tình trạng bài viết</div>
                  <div style={{ display: 'grid', gap: 8 }}>
                    {[
                      { label: 'Tổng bài', value: health.articles?.total, tip: 'Tổng số bài viết trong hệ thống' },
                      { label: 'Đã tóm tắt', value: health.articles?.done, onClick: () => goToQueue('done'), tip: 'Bài đã được AI tóm tắt thành công' },
                      { label: 'Đang tóm tắt', value: health.articles?.processing, onClick: () => goToQueue('processing'), tip: 'Bài đang được AI xử lý' },
                      { label: 'Tóm tắt lỗi', value: health.articles?.failed, onClick: () => goToQueue('failed'), tip: 'Bài tóm tắt bị lỗi — bấm để xem và xử lý' },
                      { label: 'Kiểm tra metadata', value: 'Mở', onClick: goToQuality, tip: 'Xem bài đã tóm tắt nhưng thiếu TL;DR, nhãn hoặc điểm nóng' },
                    ].map((item) => (
                      <div key={item.label} onClick={item.onClick} title={item.tip} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: '0.86rem', cursor: item.onClick ? 'pointer' : 'default', padding: '2px 4px', borderRadius: 4, transition: 'background 0.15s' }} className={item.onClick ? 'admin-clickable-row' : undefined}>
                        <span style={{ color: 'var(--color-text-muted)' }}>{item.label}{item.onClick ? ' ›' : ''}</span>
                        <strong>{item.value || 0}</strong>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="card">
                  <div style={{ fontWeight: 700, marginBottom: 10 }}>Hàng đợi lấy bài</div>
                  <div style={{ display: 'grid', gap: 8 }}>
                    {[
                      { label: 'Tổng URL', value: health.articleFetchJobs?.total, tip: 'Tổng URL đã phát hiện từ các nguồn' },
                      { label: 'Chờ lấy bài', value: health.articleFetchJobs?.discovered, onClick: () => goToFetch('discovered'), tip: 'URL đã phát hiện nhưng chưa lấy nội dung' },
                      { label: 'Đang lấy bài', value: health.articleFetchJobs?.fetching, onClick: () => goToFetch('fetching'), tip: 'URL đang được hệ thống lấy nội dung' },
                      { label: 'Lấy bài lỗi', value: health.articleFetchJobs?.failed, onClick: () => goToFetch('failed'), tip: 'URL lấy nội dung bị lỗi — bấm để xem và thử lại' },
                    ].map((item) => (
                      <div key={item.label} onClick={item.onClick} title={item.tip} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: '0.86rem', cursor: item.onClick ? 'pointer' : 'default', padding: '2px 4px', borderRadius: 4, transition: 'background 0.15s' }} className={item.onClick ? 'admin-clickable-row' : undefined}>
                        <span style={{ color: 'var(--color-text-muted)' }}>{item.label}{item.onClick ? ' ›' : ''}</span>
                        <strong>{item.value || 0}</strong>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {health.sourceQuality?.length > 0 && (
                <div className="card">
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap', marginBottom: 10 }}>
                    <div>
                      <div style={{ fontWeight: 700 }}>Chất lượng nguồn tin</div>
                      <div style={{ fontSize: '0.78rem', color: 'var(--color-text-muted)', marginTop: 2 }}>
                        Theo dõi nguồn lỗi, nguồn ít bài mới và tỷ lệ thêm bài trong 24h gần nhất.
                      </div>
                    </div>
                    <button className="btn btn-sm" onClick={() => window.location.href = '/sources'}>Mở trang Nguồn tin</button>
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8, marginBottom: 12 }}>
                    {[
                      ['Ổn', health.sourceQualitySummary?.healthy, 'var(--color-success)'],
                      ['Ít bài mới', health.sourceQualitySummary?.low_yield, 'var(--color-warning)'],
                      ['Đang lỗi', health.sourceQualitySummary?.failing, 'var(--color-error)'],
                      ['Lâu chưa thành công', health.sourceQualitySummary?.stale, 'var(--color-warning)'],
                      ['Đã tắt', health.sourceQualitySummary?.disabled, 'var(--color-text-muted)'],
                    ].map(([label, value, color]) => (
                      <div key={String(label)} style={{ padding: '10px 12px', border: '1px solid var(--color-border-light)', borderRadius: 8 }}>
                        <div style={{ fontSize: '1.35rem', lineHeight: 1, fontWeight: 800, color: String(color) }}>{value || 0}</div>
                        <div style={{ fontSize: '0.78rem', fontWeight: 600, marginTop: 6 }}>{label}</div>
                      </div>
                    ))}
                  </div>

                  <div style={{ display: 'grid', gap: 8 }}>
                    {health.sourceQuality
                      .filter((source: AdminSourceQuality) => source.status !== 'healthy')
                      .slice(0, 8)
                      .map((source: AdminSourceQuality, i: number) => (
                        <div key={source.id} style={{ fontSize: '0.8rem', paddingTop: i === 0 ? 0 : 8, borderTop: i === 0 ? 'none' : '1px solid var(--color-border-light)' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                            <strong>{source.name}</strong>
                            <span className={`badge badge-${sourceQualityBadgeClass(source.status)}`}>{sourceQualityLabel(source.status)}</span>
                          </div>
                          <div style={{ color: 'var(--color-text-muted)', marginTop: 3 }}>
                            24h: {source.runs24h || 0} lần cào · tìm thấy {source.itemsFound24h || 0} · thêm {source.itemsInserted24h || 0} · tỷ lệ thêm {percentText(source.insertRate24h)}
                          </div>
                          <div style={{ color: source.status === 'failing' ? 'var(--color-error)' : 'var(--color-text-muted)', marginTop: 3 }}>
                            {sourceQualityNote(source).substring(0, 180)}
                          </div>
                        </div>
                      ))}
                    {health.sourceQuality.filter((source: AdminSourceQuality) => source.status !== 'healthy').length === 0 && (
                      <div style={{ color: 'var(--color-text-muted)', fontSize: '0.82rem' }}>Tất cả nguồn đang ổn.</div>
                    )}
                  </div>
                </div>
              )}

              {health.forum && ((health.forum.totals24h?.length || 0) > 0 || (health.forum.recent?.length || 0) > 0) && (
                <div className="card">
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap', marginBottom: 10 }}>
                    <div>
                      <div style={{ fontWeight: 700 }}>Theo dõi forum Reddit/VOZ</div>
                      <div style={{ fontSize: '0.78rem', color: 'var(--color-text-muted)', marginTop: 2 }}>
                        Số liệu 24h gần nhất để biết thread bị bỏ qua vì ít comment, ít comment hữu ích hay lỗi fetch.
                      </div>
                    </div>
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 8, marginBottom: 12 }}>
                    {health.forum.totals24h?.map((row) => (
                      <div key={row.kind} style={{ padding: '10px 12px', border: '1px solid var(--color-border-light)', borderRadius: 8 }}>
                        <div style={{ fontSize: '0.86rem', fontWeight: 700, marginBottom: 8 }}>{forumKindLabel(row.kind)}</div>
                        <div style={{ display: 'grid', gap: 5, fontSize: '0.78rem' }}>
                          {[
                            ['Thread đã xem', row.threadsSeen],
                            ['Đã thêm', row.inserted],
                            ['Bỏ qua: ít comment', row.skippedFewComments],
                            ['Bỏ qua: ít comment hữu ích', row.skippedFewUsefulComments],
                            ['Trùng bài', row.skippedDuplicate],
                            ['Lỗi fetch comment', row.fetchErrors],
                          ].map(([label, value]) => (
                            <div key={String(label)} style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                              <span style={{ color: 'var(--color-text-muted)' }}>{label}</span>
                              <strong>{value || 0}</strong>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>

                  {health.forum.recent?.length > 0 && (
                    <div style={{ display: 'grid', gap: 8 }}>
                      {health.forum.recent.slice(0, 4).map((log, i: number) => (
                        <div key={`${log.source_id || 'forum'}-${log.started_at}-${i}`} style={{ fontSize: '0.78rem', paddingTop: i === 0 ? 0 : 8, borderTop: i === 0 ? 'none' : '1px solid var(--color-border-light)' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                            <strong>{log.source_name || log.source_id || forumKindLabel(log.forum?.kind)}</strong>
                            <span style={{ color: 'var(--color-text-muted)' }}>{new Date(log.started_at).toLocaleString('vi-VN')}</span>
                          </div>
                          <div style={{ color: 'var(--color-text-muted)', marginTop: 3 }}>
                            {forumKindLabel(log.forum?.kind)} · xem {forumStatsValue(log, 'threadsSeen')} · thêm {forumStatsValue(log, 'inserted')} · ít comment {forumStatsValue(log, 'skippedFewComments')} · ít hữu ích {forumStatsValue(log, 'skippedFewUsefulComments')} · lỗi fetch {forumStatsValue(log, 'fetchErrors')}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {health.lastDigest && (
                <div className="card">
                  <div style={{ fontWeight: 700, marginBottom: 6 }}>Bản tin gần nhất</div>
                  <div style={{ fontSize: '0.86rem' }}>{health.lastDigest.title || `Bản tin ${health.lastDigest.digest_date}`}</div>
                  <div style={{ fontSize: '0.76rem', color: 'var(--color-text-muted)', marginTop: 3 }}>
                    {health.lastDigest.article_count || 0} bài · ngày {health.lastDigest.digest_date}
                  </div>
                </div>
              )}

              <div className="card">
                <div style={{ fontWeight: 700, marginBottom: 6 }}>Chạy thủ công</div>
                <div style={{ fontSize: '0.78rem', color: 'var(--color-text-muted)', marginBottom: 10 }}>
                  Dùng khi anh muốn ép hệ thống chạy ngay, không cần chờ lịch tự động.
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button className="btn btn-sm" onClick={() => trigger('scrape', api.triggerScrape)} disabled={!!actionLoading}>
                    {actionLoading === 'scrape' ? 'Đang chạy...' : 'Cào nguồn đến hạn'}
                  </button>
                  <button className="btn btn-sm" onClick={() => trigger('fetch-articles', api.triggerFetchArticles)} disabled={!!actionLoading}>
                    {actionLoading === 'fetch-articles' ? 'Đang chạy...' : 'Lấy nội dung bài'}
                  </button>
                  <button className="btn btn-sm" onClick={() => trigger('summarize', api.triggerSummarize)} disabled={!!actionLoading}>
                    {actionLoading === 'summarize' ? 'Đang chạy...' : 'Tóm tắt bài'}
                  </button>
                  <button className="btn btn-sm" onClick={() => trigger('digest', api.triggerDigest)} disabled={!!actionLoading}>
                    {actionLoading === 'digest' ? 'Đang chạy...' : 'Tạo bản tin'}
                  </button>
                </div>
              </div>

              {health.recentLogs?.length > 0 && (
                <div className="card">
                  <div style={{ fontWeight: 700, marginBottom: 10 }}>Lần cào gần đây</div>
                  {health.recentLogs.map((log: AdminScrapeLog, i: number) => (
                    <div key={i} style={{ fontSize: '0.82rem', padding: '8px 0', borderBottom: i < health.recentLogs.length - 1 ? '1px solid var(--color-border-light)' : 'none' }}>
                      <span className={`badge badge-${log.status === 'success' ? 'success' : log.status === 'failed' ? 'error' : 'pending'}`}>
                        {statusLabel(log.status)}
                      </span>
                      {' '}
                      <span style={{ color: 'var(--color-text-muted)' }}>
                        {new Date(log.started_at).toLocaleString('vi-VN')}
                      </span>
                      <span> · tìm thấy {log.items_found || 0}, thêm mới {log.items_inserted || 0}</span>
                      {log.error_message && (
                        <div style={{ color: 'var(--color-error)', fontSize: '0.75rem', marginTop: 2 }}>
                          {log.error_message.substring(0, 140)}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : null}
        </div>

  );
}

import { useEffect, useMemo, useState } from 'react';
import { api } from '../../services/api';
import { useFetchRaw } from '../../hooks/useApi';
import {
  AdminStats,
  AdminStatsDailyPoint,
  AdminVisitStats,
} from './adminHelpers';

type AdminStatsResponse = { data: AdminStats };
type AdminVisitStatsResponse = { data: AdminVisitStats };

function todayVn(): string {
  // en-CA cho dinh dang YYYY-MM-DD san; timeZone dam bao lay dung ngay theo gio VN
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
}

function daysAgoVn(days: number): string {
  const base = new Date(`${todayVn()}T00:00:00Z`).getTime() - days * 24 * 60 * 60 * 1000;
  return new Date(base).toISOString().slice(0, 10);
}

function dayMs(date: string): number {
  return new Date(`${date}T00:00:00Z`).getTime();
}

// Visits chi cho phep toi da 31 ngay; neu khoang rong hon thi keo "from" lai gan "to".
function clampVisitFrom(from: string, to: string): string {
  const maxFromMs = dayMs(to) - 30 * 24 * 60 * 60 * 1000;
  return dayMs(from) < maxFromMs ? new Date(maxFromMs).toISOString().slice(0, 10) : from;
}

function percentText(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return `${Math.round(value * 100)}%`;
}

const PRESETS: { label: string; days: number }[] = [
  { label: 'Hôm nay', days: 0 },
  { label: '7 ngày', days: 6 },
  { label: '30 ngày', days: 29 },
];

// Gop 2 chuoi ngay (bai lay duoc / loi fetch) thanh 1 truc thoi gian de ve cot
function mergeDaily(articles: AdminStatsDailyPoint[], fetchFailed: AdminStatsDailyPoint[]) {
  const map = new Map<string, { date: string; articles: number; fetchFailed: number }>();
  for (const row of articles) map.set(row.date, { date: row.date, articles: row.count, fetchFailed: 0 });
  for (const row of fetchFailed) {
    const existing = map.get(row.date);
    if (existing) existing.fetchFailed = row.count;
    else map.set(row.date, { date: row.date, articles: 0, fetchFailed: row.count });
  }
  return Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
}

export function StatsTab() {
  const [from, setFrom] = useState(() => daysAgoVn(6));
  const [to, setTo] = useState(() => todayVn());
  const [domainPage, setDomainPage] = useState(1);
  const [domainPageSize, setDomainPageSize] = useState(50);
  const [hoveredDate, setHoveredDate] = useState<string | null>(null);
  const { data: raw, loading, error, reload } = useFetchRaw<AdminStatsResponse>(
    () => api.getStats({ from, to }), [from, to]
  );
  const stats = raw?.data;

  const visitFrom = clampVisitFrom(from, to);
  const { data: visitRaw, loading: visitLoading, error: visitError, reload: reloadVisits } = useFetchRaw<AdminVisitStatsResponse>(
    () => api.getVisitStats({ from: visitFrom, to }), [visitFrom, to]
  );
  const visits = visitRaw?.data;

  const applyPreset = (days: number) => {
    setFrom(daysAgoVn(days));
    setTo(todayVn());
  };

  const reloadAll = () => { reload(); reloadVisits(); };

  // Doi khoang ngay hoac so dong/trang thi ve trang 1
  useEffect(() => { setDomainPage(1); }, [from, to, domainPageSize]);

  const daily = useMemo(
    () => stats ? mergeDaily(stats.daily.articles, stats.daily.fetchFailed) : [],
    [stats]
  );
  const maxDaily = useMemo(
    () => daily.reduce((max, row) => Math.max(max, row.articles, row.fetchFailed), 0),
    [daily]
  );
  const maxError = useMemo(
    () => (stats?.errorTypes || []).reduce((max, row) => Math.max(max, row.count), 0),
    [stats]
  );
  const allDomains = stats?.domains || [];
  const domainTotalPages = Math.max(1, Math.ceil(allDomains.length / domainPageSize));
  const domainPageSafe = Math.min(domainPage, domainTotalPages);
  const pagedDomains = useMemo(
    () => allDomains.slice((domainPageSafe - 1) * domainPageSize, domainPageSafe * domainPageSize),
    [allDomains, domainPageSafe, domainPageSize]
  );
  const maxVisitDaily = useMemo(
    () => (visits?.daily || []).reduce((max, row) => Math.max(max, row.total), 0),
    [visits]
  );
  const maxVisitIp = useMemo(
    () => (visits?.topIps || []).reduce((max, row) => Math.max(max, row.total), 0),
    [visits]
  );
  const daysCount = useMemo(() => {
    const diffMs = dayMs(to) - dayMs(visitFrom);
    return Math.max(1, Math.round(diffMs / (24 * 60 * 60 * 1000)) + 1);
  }, [visitFrom, to]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
      <div className="card" style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontWeight: 700 }}>Thống kê theo ngày</div>
          <div style={{ fontSize: '0.78rem', color: 'var(--color-text-muted)', marginTop: 2 }}>
            Số bài lấy được và số URL lỗi fetch theo từng domain, tính theo ngày hệ thống lấy bài về (giờ VN).
          </div>
        </div>
        <button className="btn btn-sm" onClick={reloadAll} disabled={loading || visitLoading}>Tải lại</button>
      </div>

      <div className="card" style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {PRESETS.map((preset) => {
            const active = from === daysAgoVn(preset.days) && to === todayVn();
            return (
              <button
                key={preset.label}
                className={`btn btn-sm ${active ? 'btn-primary' : ''}`}
                onClick={() => applyPreset(preset.days)}
              >
                {preset.label}
              </button>
            );
          })}
        </div>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: '0.74rem', color: 'var(--color-text-muted)' }}>
          Từ ngày
          <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} style={{ padding: '5px 8px' }} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: '0.74rem', color: 'var(--color-text-muted)' }}>
          Đến ngày
          <input type="date" value={to} min={from} max={todayVn()} onChange={(e) => setTo(e.target.value)} style={{ padding: '5px 8px' }} />
        </label>
      </div>

      {loading ? (
        <div className="loading">Đang tải thống kê...</div>
      ) : error ? (
        <div className="empty-state">
          <p style={{ color: 'var(--color-error)' }}>{error}</p>
          <button className="btn btn-primary" onClick={reload} style={{ marginTop: 12 }}>Thử lại</button>
        </div>
      ) : stats ? (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8 }}>
            {[
              ['Bài lấy được', stats.summary.articles, 'var(--color-success)'],
              ['URL lỗi fetch', stats.summary.fetchFailed, 'var(--color-error)'],
              ['Bài bị bỏ qua', stats.summary.skipped, 'var(--color-warning)'],
              ['Số domain', stats.summary.domains, 'var(--color-text)'],
            ].map(([label, value, color]) => (
              <div key={String(label)} className="card" style={{ padding: '10px 12px' }}>
                <div style={{ fontSize: '1.45rem', lineHeight: 1, fontWeight: 800, color: String(color) }}>{Number(value).toLocaleString('vi-VN')}</div>
                <div style={{ fontSize: '0.78rem', fontWeight: 600, marginTop: 6 }}>{label}</div>
              </div>
            ))}
          </div>

          <div className="card">
            <div style={{ fontWeight: 700, marginBottom: 4 }}>Bài lấy được / lỗi fetch theo ngày</div>
            <div style={{ fontSize: '0.74rem', color: 'var(--color-text-muted)', marginBottom: 12 }}>
              Cột xanh: bài lấy được · cột đỏ: URL lỗi fetch. Ngày nào cột xanh thấp bất thường là hệ thống đói tin.
            </div>
            {daily.length === 0 ? (
              <div style={{ fontSize: '0.82rem', color: 'var(--color-text-muted)' }}>Không có dữ liệu trong khoảng này.</div>
            ) : (
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, overflowX: 'auto', paddingBottom: 4, minHeight: 140 }}>
                {daily.map((row) => (
                  <div key={row.date} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, minWidth: 34, flex: '1 0 auto' }}>
                    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 110 }} title={`${row.date}\nbài: ${row.articles}\nlỗi fetch: ${row.fetchFailed}`}>
                      <div style={{ width: 12, height: `${maxDaily > 0 ? Math.max(2, (row.articles / maxDaily) * 110) : 2}px`, background: 'var(--color-success)', borderRadius: '2px 2px 0 0' }} />
                      <div style={{ width: 12, height: `${maxDaily > 0 ? Math.max(2, (row.fetchFailed / maxDaily) * 110) : 2}px`, background: 'var(--color-error)', borderRadius: '2px 2px 0 0', opacity: 0.85 }} />
                    </div>
                    <div style={{ fontSize: '0.62rem', color: 'var(--color-text-muted)', transform: 'rotate(-45deg)', whiteSpace: 'nowrap', transformOrigin: 'center', marginTop: 4 }}>
                      {row.date.slice(5)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="card">
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
              <div style={{ fontWeight: 700 }}>Theo domain</div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: '0.78rem', color: 'var(--color-text-muted)' }}>
                <span>{allDomains.length.toLocaleString('vi-VN')} domain</span>
                <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                  Mỗi trang
                  <select value={domainPageSize} onChange={(e) => setDomainPageSize(Number(e.target.value))} style={{ padding: '3px 6px' }}>
                    <option value={50}>50</option>
                    <option value={100}>100</option>
                  </select>
                </label>
              </div>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
                <thead>
                  <tr style={{ textAlign: 'left', color: 'var(--color-text-muted)', fontSize: '0.74rem' }}>
                    <th style={{ padding: '6px 8px' }}>Domain</th>
                    <th style={{ padding: '6px 8px', textAlign: 'right' }}>Bài lấy được</th>
                    <th style={{ padding: '6px 8px', textAlign: 'right' }}>Lỗi fetch</th>
                    <th style={{ padding: '6px 8px', textAlign: 'right' }}>Bỏ qua</th>
                    <th style={{ padding: '6px 8px', textAlign: 'right' }}>Tỷ lệ OK</th>
                  </tr>
                </thead>
                <tbody>
                  {pagedDomains.map((row) => (
                    <tr key={row.domain} style={{ borderTop: '1px solid var(--color-border-light)' }}>
                      <td style={{ padding: '6px 8px', overflowWrap: 'anywhere' }}>{row.domain}</td>
                      <td style={{ padding: '6px 8px', textAlign: 'right', fontWeight: 600 }}>{row.articles.toLocaleString('vi-VN')}</td>
                      <td style={{ padding: '6px 8px', textAlign: 'right', color: row.fetchFailed > 0 ? 'var(--color-error)' : 'var(--color-text-muted)' }}>{row.fetchFailed.toLocaleString('vi-VN')}</td>
                      <td style={{ padding: '6px 8px', textAlign: 'right', color: 'var(--color-text-muted)' }}>{row.skipped.toLocaleString('vi-VN')}</td>
                      <td style={{ padding: '6px 8px', textAlign: 'right', color: row.successRate !== null && row.successRate < 0.5 ? 'var(--color-error)' : 'var(--color-text-muted)' }}>{percentText(row.successRate)}</td>
                    </tr>
                  ))}
                  {allDomains.length === 0 && (
                    <tr><td colSpan={5} style={{ padding: '10px 8px', color: 'var(--color-text-muted)' }}>Không có dữ liệu trong khoảng này.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            {domainTotalPages > 1 && (
              <div style={{ display: 'flex', justifyContent: 'center', gap: 8, alignItems: 'center', marginTop: 10 }}>
                <button className="btn btn-sm" onClick={() => setDomainPage((p) => Math.max(1, p - 1))} disabled={domainPageSafe <= 1}>Trang trước</button>
                <span style={{ fontSize: '0.8rem', color: 'var(--color-text-muted)' }}>{domainPageSafe}/{domainTotalPages}</span>
                <button className="btn btn-sm" onClick={() => setDomainPage((p) => Math.min(domainTotalPages, p + 1))} disabled={domainPageSafe >= domainTotalPages}>Trang sau</button>
              </div>
            )}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12 }}>
            <div className="card">
              <div style={{ fontWeight: 700, marginBottom: 4 }}>Top loại lỗi fetch</div>
              <div style={{ fontSize: '0.74rem', color: 'var(--color-text-muted)', marginBottom: 12 }}>
                Gom theo thông báo lỗi để biết nên ưu tiên xử lý cái nào.
              </div>
              {stats.errorTypes.length === 0 ? (
                <div style={{ fontSize: '0.82rem', color: 'var(--color-text-muted)' }}>Không có lỗi fetch trong khoảng này.</div>
              ) : (
                <div style={{ display: 'grid', gap: 8 }}>
                  {stats.errorTypes.map((row) => (
                    <div key={row.category}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: '0.8rem', marginBottom: 3 }}>
                        <span>{row.category}</span>
                        <strong>{row.count.toLocaleString('vi-VN')}</strong>
                      </div>
                      <div style={{ height: 6, background: 'var(--color-border-light)', borderRadius: 3, overflow: 'hidden' }}>
                        <div style={{ height: '100%', width: `${maxError > 0 ? (row.count / maxError) * 100 : 0}%`, background: 'var(--color-error)', opacity: 0.8 }} />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="card">
              <div style={{ fontWeight: 700, marginBottom: 4 }}>Domain im lặng</div>
              <div style={{ fontSize: '0.74rem', color: 'var(--color-text-muted)', marginBottom: 12 }}>
                Domain có bài trong 30 ngày trước khoảng chọn nhưng không ra bài nào trong khoảng này — dấu hiệu nguồn chết âm thầm.
              </div>
              {stats.silentDomains.length === 0 ? (
                <div style={{ fontSize: '0.82rem', color: 'var(--color-text-muted)' }}>Không có domain nào im lặng.</div>
              ) : (
                <div style={{ display: 'grid', gap: 6 }}>
                  {stats.silentDomains.map((row) => (
                    <div key={row.domain} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: '0.8rem' }}>
                      <span style={{ overflowWrap: 'anywhere' }}>{row.domain}</span>
                      <span style={{ color: 'var(--color-text-muted)', flexShrink: 0 }}>{row.priorCount} bài · cuối {row.lastSeen}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="card">
            <div style={{ fontWeight: 700, marginBottom: 4 }}>Dịch AI theo ngày</div>
            <div style={{ fontSize: '0.74rem', color: 'var(--color-text-muted)', marginBottom: 12 }}>
              Số bài dịch xong / lỗi / bỏ qua mỗi ngày. Ngày nào lỗi tăng vọt là AI provider có thể đang trục trặc.
            </div>
            {stats.aiByDay.length === 0 ? (
              <div style={{ fontSize: '0.82rem', color: 'var(--color-text-muted)' }}>Không có dữ liệu trong khoảng này.</div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
                  <thead>
                    <tr style={{ textAlign: 'left', color: 'var(--color-text-muted)', fontSize: '0.74rem' }}>
                      <th style={{ padding: '6px 8px' }}>Ngày</th>
                      <th style={{ padding: '6px 8px', textAlign: 'right' }}>Xong</th>
                      <th style={{ padding: '6px 8px', textAlign: 'right' }}>Lỗi</th>
                      <th style={{ padding: '6px 8px', textAlign: 'right' }}>Bỏ qua</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.aiByDay.map((row) => (
                      <tr key={row.date} style={{ borderTop: '1px solid var(--color-border-light)' }}>
                        <td style={{ padding: '6px 8px' }}>{row.date}</td>
                        <td style={{ padding: '6px 8px', textAlign: 'right', color: 'var(--color-success)', fontWeight: 600 }}>{row.done.toLocaleString('vi-VN')}</td>
                        <td style={{ padding: '6px 8px', textAlign: 'right', color: row.failed > 0 ? 'var(--color-error)' : 'var(--color-text-muted)' }}>{row.failed.toLocaleString('vi-VN')}</td>
                        <td style={{ padding: '6px 8px', textAlign: 'right', color: 'var(--color-text-muted)' }}>{row.skipped.toLocaleString('vi-VN')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      ) : null}

      <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ fontWeight: 700 }}>Lượt truy cập website</div>
        <div style={{ fontSize: '0.74rem', color: 'var(--color-text-muted)' }}>
          Đọc từ log máy chủ nginx (tối đa 31 ngày). Đếm mọi request HTTP, đã tách "người" và "bot" theo trình duyệt và theo đường dẫn dò lỗ hổng (scanner giả trình duyệt vẫn bị xếp vào bot), loại bỏ truy cập nội bộ VPS.
          {visitFrom !== from && ' Khoảng lượt truy cập đã được rút về 31 ngày gần nhất.'}
        </div>
      </div>

      {visitLoading ? (
        <div className="loading">Đang đọc log truy cập...</div>
      ) : visitError ? (
        <div className="empty-state">
          <p style={{ color: 'var(--color-error)' }}>{visitError}</p>
          <button className="btn btn-primary" onClick={reloadVisits} style={{ marginTop: 12 }}>Thử lại</button>
        </div>
      ) : visits && !visits.available ? (
        <div className="card" style={{ borderColor: 'var(--color-warning)', background: 'rgba(245, 158, 11, 0.08)' }}>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>Chưa đọc được log truy cập</div>
          <div style={{ fontSize: '0.82rem', color: 'var(--color-text-muted)' }}>{visits.reason || 'Không có dữ liệu log.'}</div>
        </div>
      ) : visits ? (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8 }}>
            {[
              ['Lượt người', visits.totals.humanRequests, 'var(--color-success)'],
              ['IP người', visits.totals.uniqueHumanIps, 'var(--color-text)'],
              ['Lượt bot', visits.totals.botRequests, 'var(--color-warning)'],
              ['Tổng lượt', visits.totals.requests, 'var(--color-text)'],
              ['Tổng IP', visits.totals.uniqueIps, 'var(--color-text-muted)'],
            ].map(([label, value, color]) => (
              <div key={String(label)} className="card" style={{ padding: '10px 12px' }}>
                <div style={{ fontSize: '1.45rem', lineHeight: 1, fontWeight: 800, color: String(color) }}>{Number(value).toLocaleString('vi-VN')}</div>
                <div style={{ fontSize: '0.78rem', fontWeight: 600, marginTop: 6 }}>{label}</div>
              </div>
            ))}
          </div>
          {visits.reason && (
            <div style={{ fontSize: '0.74rem', color: 'var(--color-warning)' }}>{visits.reason}</div>
          )}

          <div className="card">
            <div style={{ fontWeight: 700, marginBottom: 4 }}>Lượt truy cập theo ngày</div>
            <div style={{ fontSize: '0.74rem', color: 'var(--color-text-muted)', marginBottom: 12 }}>
              Cột xanh: lượt người · cột mờ: tổng (gồm bot). Số dưới mỗi cột là số IP khác nhau hôm đó. Hover để xem chi tiết.
            </div>
            {visits.daily.length === 0 ? (
              <div style={{ fontSize: '0.82rem', color: 'var(--color-text-muted)' }}>Không có lượt truy cập trong khoảng này.</div>
            ) : (
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, overflowX: 'auto', paddingBottom: 4, minHeight: 180 }}>
                {visits.daily.map((row) => {
                  const hPct = maxVisitDaily > 0 ? (row.humans / maxVisitDaily) * 110 : 0;
                  const bVal = Math.max(0, row.total - row.humans);
                  const bPct = maxVisitDaily > 0 ? (bVal / maxVisitDaily) * 110 : 0;

                  return (
                    <div key={row.date} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, minWidth: 44, flex: '1 0 auto', position: 'relative' }}>
                      {hoveredDate === row.date && (
                        <div style={{
                          position: 'absolute',
                          bottom: '100%',
                          left: '50%',
                          transform: 'translateX(-50%)',
                          marginBottom: 8,
                          padding: '8px 10px',
                          background: 'var(--color-bg-card)',
                          border: '1px solid var(--color-border)',
                          borderRadius: 6,
                          fontSize: '0.74rem',
                          whiteSpace: 'nowrap',
                          zIndex: 100,
                          boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 3,
                        }}>
                          <strong style={{ borderBottom: '1px solid var(--color-border-light)', paddingBottom: 3, marginBottom: 3 }}>{row.date}</strong>
                          <span style={{ color: 'var(--color-success)', display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                            <span>Người:</span> <strong>{row.humans.toLocaleString('vi-VN')}</strong>
                          </span>
                          <span style={{ color: 'var(--color-warning)', display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                            <span>Bot:</span> <strong>{bVal.toLocaleString('vi-VN')}</strong>
                          </span>
                          <span style={{ borderTop: '1px solid var(--color-border-light)', paddingTop: 3, display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                            <span>Tổng request:</span> <strong>{row.total.toLocaleString('vi-VN')}</strong>
                          </span>
                          <span style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                            <span>IP duy nhất:</span> <strong>{row.uniqueIps}</strong>
                          </span>
                        </div>
                      )}

                      <div
                        onMouseEnter={() => setHoveredDate(row.date)}
                        onMouseLeave={() => setHoveredDate(null)}
                        style={{ display: 'flex', flexDirection: 'column', height: 110, width: 24, justifyContent: 'flex-end', cursor: 'pointer' }}
                      >
                        {bPct > 0 && (
                          <div style={{ height: `${bPct}px`, background: '#94a3b8', opacity: 0.5, borderRadius: hPct === 0 ? '2px 2px 0 0' : '0' }} />
                        )}
                        {hPct > 0 && (
                          <div style={{ height: `${hPct}px`, background: 'var(--color-success)', borderRadius: '2px 2px 0 0' }} />
                        )}
                      </div>
                      <div style={{ fontSize: '0.6rem', color: 'var(--color-text-muted)' }}>{row.uniqueIps}</div>
                      <div style={{ fontSize: '0.62rem', color: 'var(--color-text-muted)', transform: 'rotate(-45deg)', whiteSpace: 'nowrap', transformOrigin: 'center' }}>
                        {row.date.slice(5)}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="card">
            <div style={{ fontWeight: 700, marginBottom: 4 }}>Top IP truy cập</div>
            <div style={{ fontSize: '0.74rem', color: 'var(--color-text-muted)', marginBottom: 12 }}>
              IP nhiều request nhất trong khoảng. Một IP có nhiều "lượt bot" hoặc rất nhiều request thường là crawler.
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
                <thead>
                  <tr style={{ textAlign: 'left', color: 'var(--color-text-muted)', fontSize: '0.74rem' }}>
                    <th style={{ padding: '6px 8px' }}>IP</th>
                    <th style={{ padding: '6px 8px', textAlign: 'right' }}>Tổng</th>
                    <th style={{ padding: '6px 8px', textAlign: 'right' }}>Người</th>
                    <th style={{ padding: '6px 8px', textAlign: 'right' }}>Bot</th>
                    <th style={{ padding: '6px 8px', textAlign: 'right' }}>Số đường dẫn</th>
                    <th style={{ padding: '6px 8px', width: '28%' }}></th>
                  </tr>
                </thead>
                <tbody>
                  {visits.topIps.map((row) => (
                    <tr key={row.ip} style={{ borderTop: '1px solid var(--color-border-light)' }}>
                      <td style={{ padding: '6px 8px', fontFamily: 'monospace' }}>{row.ip}</td>
                      <td style={{ padding: '6px 8px', textAlign: 'right', fontWeight: 600 }}>{row.total.toLocaleString('vi-VN')}</td>
                      <td style={{ padding: '6px 8px', textAlign: 'right', color: 'var(--color-success)' }}>{row.humans.toLocaleString('vi-VN')}</td>
                      <td style={{ padding: '6px 8px', textAlign: 'right', color: row.bot > 0 ? 'var(--color-warning)' : 'var(--color-text-muted)' }}>{row.bot.toLocaleString('vi-VN')}</td>
                      <td style={{ padding: '6px 8px', textAlign: 'right', color: 'var(--color-text-muted)' }}>{row.paths}</td>
                      <td style={{ padding: '6px 8px' }}>
                        <div style={{ height: 6, background: 'var(--color-border-light)', borderRadius: 3, overflow: 'hidden' }}>
                          <div style={{ height: '100%', width: `${maxVisitIp > 0 ? (row.total / maxVisitIp) * 100 : 0}%`, background: 'var(--color-text-muted)', opacity: 0.6 }} />
                        </div>
                      </td>
                    </tr>
                  ))}
                  {visits.topIps.length === 0 && (
                    <tr><td colSpan={8} style={{ padding: '10px 8px', color: 'var(--color-text-muted)' }}>Không có lượt truy cập trong khoảng này.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

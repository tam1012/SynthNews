import { NavLink, useLocation } from 'react-router-dom';
import { useMemo } from 'react';
import { FONT_SIZES } from '../hooks/useApi';

interface SidebarProps {
  onOpenSearch?: () => void;
  theme?: string;
  toggleTheme?: () => void;
  fontSize?: number;
  setFontSize?: (size: number) => void;
}

/** Trích xuất date slug (ddmmyyyy) từ pathname nếu có, ví dụ /15062026/news → "15062026" */
function extractDateSlug(pathname: string): string | null {
  const m = pathname.match(/^\/(\d{8})(?:\/|$)/);
  return m ? m[1] : null;
}

/** Các tab feed được phép ghép ngày vào URL */
const FEED_TABS = ['/news', '/tech', '/voz', '/reddit', '/saved', '/digest'];

export function Sidebar({
  onOpenSearch,
  theme,
  toggleTheme,
  fontSize,
  setFontSize,
}: SidebarProps) {
  const location = useLocation();
  const path = location.pathname;
  const dateSlug = useMemo(() => extractDateSlug(path), [path]);

  // Ghép date slug vào href nếu đang xem một ngày cụ thể
  const navHref = (baseHref: string) => {
    if (!dateSlug) return baseHref;
    if (baseHref === '/') return `/${dateSlug}`;
    if (FEED_TABS.includes(baseHref)) return `/${dateSlug}${baseHref}`;
    return baseHref;
  };

  const navItems = [
    { name: 'All News', href: navHref('/'), icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-2 2Zm0 0a2 2 0 0 1-2-2v-9c0-1.1.9-2 2-2h2"/><path d="M18 14h-8"/><path d="M15 18h-5"/><path d="M10 6h8v4h-8V6Z"/></svg> },
    { name: 'News', href: navHref('/news'), icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 11a9 9 0 0 1 9 9"/><path d="M4 4a16 16 0 0 1 16 16"/><circle cx="5" cy="19" r="1"/></svg> },
    { name: 'Tech News', href: navHref('/tech'), icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg> },
    { name: 'VOZ', href: navHref('/voz'), icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9"/><path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.4"/><circle cx="12" cy="12" r="2"/><path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.4"/><path d="M19.1 4.9C23 8.8 23 15.1 19.1 19"/></svg> },
    { name: 'Reddit', href: navHref('/reddit'), icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg> },
    { name: 'Đã lưu', href: navHref('/saved'), icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg> },
    { name: 'Bản tin', href: navHref('/digest'), icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg> },
  ];

  const isNavActive = (href: string) => {
    // "All News" — matches /, /<date>, /article/*
    if (href === '/' || (dateSlug && href === `/${dateSlug}`)) {
      if (path.startsWith('/article')) return true;
      return path === href;
    }
    // Sources & Admin dùng prefix match để phủ sub-tab
    if (href === '/sources' || href === '/admin') {
      return path.startsWith(href);
    }
    // Feed tabs — so khớp chính xác (đã bao gồm date prefix nếu có)
    return path === href;
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <NavLink
          to="/"
          className="sidebar-logo"
          onClick={(e) => {
            if (window.location.pathname === '/') {
              e.preventDefault();
              window.location.reload();
            }
          }}
        >
          SynthNews
        </NavLink>
        <span className="sidebar-subtitle">The world's news, in your language</span>
      </div>

      <nav className="sidebar-nav">
        {navItems.map((item) => (
          <NavLink
            key={item.href}
            to={item.href}
            end={item.name === 'All News'}
            className={`sidebar-nav-item ${isNavActive(item.href) ? 'active' : ''}`}
          >
            <span className="sidebar-nav-icon">{item.icon}</span>
            <span className="sidebar-nav-label">{item.name}</span>
          </NavLink>
        ))}
      </nav>

      <div className="sidebar-footer">
        <NavLink to="/sources" className={`sidebar-nav-item ${path.startsWith('/sources') ? 'active' : ''}`}>
          <span className="sidebar-nav-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg></span>
          <span className="sidebar-nav-label">Nguồn tin</span>
        </NavLink>
        <NavLink to="/admin" className={`sidebar-nav-item ${path.startsWith('/admin') ? 'active' : ''}`}>
          <span className="sidebar-nav-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68 1.65 1.65 0 0 0 10 3.17V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></span>
          <span className="sidebar-nav-label">Admin</span>
        </NavLink>
        <button className="sidebar-search-btn" onClick={onOpenSearch}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <span>Search</span>
          <kbd className="sidebar-search-kbd">Ctrl+K</kbd>
        </button>

        {toggleTheme && setFontSize && (
          <div className="sidebar-quick-settings">
            <button
              className="sidebar-theme-toggle"
              onClick={toggleTheme}
              title={theme === 'light' ? 'Chế độ tối' : 'Chế độ sáng'}
            >
              {theme === 'light' ? '☀' : '☾'}
            </button>
            <div className="sidebar-font-picker">
              <button
                className="sidebar-font-trigger"
                type="button"
                aria-haspopup="menu"
                aria-label="Chọn cỡ chữ"
                title="Chọn cỡ chữ"
              >
                Cỡ chữ: {fontSize}px
              </button>
              <div className="sidebar-font-menu" role="menu" aria-label="Chọn cỡ chữ">
                {FONT_SIZES.map(size => (
                  <button
                    key={size}
                    type="button"
                    className={`sidebar-font-option ${fontSize === size ? 'active' : ''}`}
                    onClick={() => setFontSize(size)}
                    role="menuitemradio"
                    aria-checked={fontSize === size}
                  >
                    {size}px
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}

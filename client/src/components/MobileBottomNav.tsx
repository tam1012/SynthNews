import { NavLink, useLocation } from 'react-router-dom';
import { useEffect, useRef, useMemo } from 'react';

/** Trích xuất date slug (ddmmyyyy) từ pathname nếu có, ví dụ /15062026/news → "15062026" */
function extractDateSlug(pathname: string): string | null {
  const m = pathname.match(/^\/(\d{8})(?:\/|$)/);
  return m ? m[1] : null;
}

/** Các tab feed được phép ghép ngày vào URL */
const FEED_TABS = ['/news', '/tech', '/voz', '/reddit', '/saved', '/digest'];

export function MobileBottomNav() {
  const location = useLocation();
  const path = location.pathname;
  const navRef = useRef<HTMLElement>(null);
  const dateSlug = useMemo(() => extractDateSlug(path), [path]);

  // Ghép date slug vào href nếu đang xem một ngày cụ thể
  const navHref = (baseHref: string) => {
    if (!dateSlug) return baseHref;
    if (baseHref === '/') return `/${dateSlug}`;
    if (FEED_TABS.includes(baseHref)) return `/${dateSlug}${baseHref}`;
    return baseHref;
  };

  const tabs = [
    { label: 'Tất cả', href: navHref('/') },
    { label: 'News', href: navHref('/news') },
    { label: 'Tech', href: navHref('/tech') },
    { label: 'VOZ', href: navHref('/voz') },
    { label: 'Reddit', href: navHref('/reddit') },
    { label: 'Đã lưu', href: navHref('/saved') },
    { label: 'Bản tin', href: navHref('/digest') },
    { label: 'Nguồn tin', href: navHref('/sources') },
    { label: 'Admin', href: navHref('/admin') },
  ];

  const isActive = (href: string) => {
    // "Tất cả" — matches /, /<date>, /article/*
    if (href === '/' || (dateSlug && href === `/${dateSlug}`)) {
      if (path.startsWith('/article')) return true;
      return path === href;
    }
    // Admin dùng prefix match để phủ sub-tab
    if (href === '/admin') return path === '/admin' || path.startsWith('/admin/');
    // Sources dùng prefix match
    if (href === '/sources') return path.startsWith(href);
    // Feed tabs — so khớp chính xác (đã bao gồm date prefix nếu có)
    return path === href;
  };

  // Scroll active tab into view when route changes
  useEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const activeEl = nav.querySelector('.mobile-bottom-item.active') as HTMLElement | null;
    if (!activeEl) return;
    const navRect = nav.getBoundingClientRect();
    const itemRect = activeEl.getBoundingClientRect();
    const target = nav.scrollLeft + (itemRect.left - navRect.left) - (navRect.width / 2) + (itemRect.width / 2);
    nav.scrollTo({ left: Math.max(0, target), behavior: 'smooth' });
  }, [path]);

  return (
    <nav className="mobile-bottom-nav" ref={navRef}>
      {tabs.map((item) => (
        <NavLink
          key={item.href}
          to={item.href}
          className={`mobile-bottom-item ${isActive(item.href) ? 'active' : ''}`}
        >
          <span className="mobile-bottom-label">{item.label}</span>
        </NavLink>
      ))}
    </nav>
  );
}

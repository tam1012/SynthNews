import { NavLink, useLocation } from 'react-router-dom';
import { useEffect, useRef } from 'react';

export function MobileBottomNav() {
  const location = useLocation();
  const path = location.pathname;
  const navRef = useRef<HTMLElement>(null);

  const tabs = [
    { label: 'Tất cả', href: '/' },
    { label: 'News', href: '/news' },
    { label: 'Tech', href: '/tech' },
    { label: 'VOZ', href: '/voz' },
    { label: 'Reddit', href: '/reddit' },
    { label: 'Bản tin', href: '/digest' },
    { label: 'Nguồn tin', href: '/sources' },
    { label: 'Admin', href: '/admin' },
  ];

  const isActive = (href: string) => {
    if (href === '/') return path === '/' || path.startsWith('/article');
    if (href === '/admin') return path === '/admin' || path.startsWith('/admin/');
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

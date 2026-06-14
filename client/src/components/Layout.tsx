import { Outlet } from 'react-router-dom';
import { useEffect, useState, useRef } from 'react';
import { FONT_SIZES, useSettings } from '../hooks/useApi';
import { Sidebar } from './Sidebar';
import { MobileTopNav } from './MobileTopNav';
import { MobileBottomNav } from './MobileBottomNav';
import { SearchModal } from './SearchModal';

export function Layout() {
  const { fontSize, setFontSize, theme, toggleTheme } = useSettings();
  const [showSettingsSheet, setShowSettingsSheet] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const sheetRef = useRef<HTMLDivElement>(null);

  // Global Ctrl+K / Cmd+K to open search
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        setShowSearch(prev => !prev);
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, []);

  // Close bottom sheet on click outside
  useEffect(() => {
    if (!showSettingsSheet) return;
    const handleClick = (e: MouseEvent) => {
      if (sheetRef.current && !sheetRef.current.contains(e.target as Node)) {
        setShowSettingsSheet(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showSettingsSheet]);

  // Lock body scroll when settings sheet is open
  useEffect(() => {
    if (showSettingsSheet) {
      const scrollY = window.scrollY;
      document.body.style.position = 'fixed';
      document.body.style.top = `-${scrollY}px`;
      document.body.style.left = '0';
      document.body.style.right = '0';
      document.body.style.overflow = 'hidden';
      return () => {
        document.body.style.position = '';
        document.body.style.top = '';
        document.body.style.left = '';
        document.body.style.right = '';
        document.body.style.overflow = '';
        window.scrollTo(0, scrollY);
      };
    }
  }, [showSettingsSheet]);

  return (
    <>
      <div className="app-shell">
        <Sidebar
          onOpenSearch={() => setShowSearch(true)}
          theme={theme}
          toggleTheme={toggleTheme}
          fontSize={fontSize}
          setFontSize={setFontSize}
        />
        <div className="app-main">
          <MobileTopNav onOpenSettings={() => setShowSettingsSheet(true)} onOpenSearch={() => setShowSearch(true)} />
          <main className="app-content">
            <Outlet />
          </main>
          <MobileBottomNav />
        </div>
      </div>

      {/* Settings Bottom Sheet (mobile) */}
      {showSettingsSheet && (
        <div className="settings-sheet-overlay" onClick={() => setShowSettingsSheet(false)}>
          <div
            className="settings-sheet"
            ref={sheetRef}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="settings-sheet-handle" />
            <h3 className="settings-sheet-title">Cài đặt</h3>

            <div className="settings-sheet-row">
              <span>Giao diện</span>
              <div className="settings-sheet-toggle">
                <button
                  className={`settings-toggle-btn ${theme === 'light' ? 'active' : ''}`}
                  onClick={() => { if (theme !== 'light') toggleTheme(); }}
                >☀️</button>
                <button
                  className={`settings-toggle-btn ${theme === 'dark' ? 'active' : ''}`}
                  onClick={() => { if (theme !== 'dark') toggleTheme(); }}
                >🌙</button>
              </div>
            </div>

            <div className="settings-sheet-font-size">
              <div className="settings-sheet-row-heading">
                <span>Cỡ chữ</span>
                <strong>{fontSize}px</strong>
              </div>
              <div className="settings-sheet-font-grid" role="group" aria-label="Chọn cỡ chữ">
                {FONT_SIZES.map(size => (
                  <button
                    key={size}
                    type="button"
                    className={`settings-sheet-font-option ${fontSize === size ? 'active' : ''}`}
                    onClick={() => setFontSize(size)}
                  >
                    {size}px
                  </button>
                ))}
              </div>
            </div>


            <button
              className="settings-sheet-close"
              onClick={() => setShowSettingsSheet(false)}
            >
              Xong
            </button>
          </div>
        </div>
      )}

      {/* Search Modal */}
      <SearchModal open={showSearch} onClose={() => setShowSearch(false)} />
    </>
  );
}

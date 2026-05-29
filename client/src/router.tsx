import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { lazy, Suspense } from 'react';
import { Layout } from './components/Layout';
import { Home } from './pages/Home';

const Sources = lazy(() => import('./pages/Sources').then(m => ({ default: m.Sources })));
const Admin = lazy(() => import('./pages/Admin').then(m => ({ default: m.Admin })));

function PageLoader() {
  return <div style={{ textAlign: 'center', padding: '48px 16px', color: 'var(--color-text-muted)' }}>Đang tải...</div>;
}

export function Router() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<Home />} />
          <Route path="/news" element={<Home />} />
          <Route path="/tech" element={<Home />} />
          <Route path="/voz" element={<Home />} />
          <Route path="/reddit" element={<Home />} />
          <Route path="/digest" element={<Home />} />
          <Route path="/:dateSlug" element={<Home />} />
          <Route path="/article/:articleId" element={<Home />} />
          <Route path="/sources" element={<Suspense fallback={<PageLoader />}><Sources /></Suspense>} />
          <Route path="/admin" element={<Suspense fallback={<PageLoader />}><Admin /></Suspense>} />
          <Route path="/admin/:tab" element={<Suspense fallback={<PageLoader />}><Admin /></Suspense>} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

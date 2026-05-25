import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { existsSync, readFileSync } from 'fs';
import { join, dirname, extname } from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

import { sources } from './routes/sources.js';
import { articles } from './routes/articles.js';
import { digests } from './routes/digests.js';
import { health } from './routes/health.js';
import { imageProxy } from './routes/image-proxy.js';
import { aiProviders } from './routes/ai-providers.js';
import { settings } from './routes/settings.js';
import { blocklist } from './routes/blocklist.js';
import { assertAdminTokenConfigured, authMiddleware } from './lib/auth.js';
import { writeRateLimitMiddleware } from './lib/rateLimit.js';
import { getOne } from './db/index.js';
import { startCronJobs } from './jobs/scheduler.js';
import { buildArticleMeta, injectArticleMeta } from './lib/openGraph.js';

dotenv.config();
assertAdminTokenConfigured();

import { compress } from 'hono/compress';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = new Hono();

// Middleware
app.use('*', compress());
app.use('*', logger());
app.use('*', cors({
  origin: process.env.CORS_ORIGIN || (process.env.PUBLIC_SITE_URL ? process.env.PUBLIC_SITE_URL.replace(/\/$/, '') : '*'),
  allowMethods: ['GET', 'POST', 'PATCH', 'DELETE'],
  allowHeaders: ['Content-Type', 'Authorization'],
}));

// Add long-term caching for static assets built by Vite
app.use('/assets/*', async (c, next) => {
  await next();
  c.header('Cache-Control', 'public, max-age=31536000, immutable');
});

// Image proxy (public, no auth required)
app.route('/api/img', imageProxy);

// Auth and write protection
app.use('/api/*', writeRateLimitMiddleware);
app.use('/api/*', authMiddleware);

// API Routes
app.route('/api/health', health);
app.route('/api/sources', sources);
app.route('/api/articles', articles);
app.route('/api/digests', digests);
app.route('/api/ai-providers', aiProviders);
app.route('/api/settings', settings);
app.route('/api/blocklist', blocklist);

// Serve static frontend (production)
const publicDir = join(__dirname, '..', 'public');
if (existsSync(publicDir)) {
  const indexHtmlPath = join(publicDir, 'index.html');
  const renderSpaHtml = async (path: string, requestUrl: string) => {
    const indexHtml = readFileSync(indexHtmlPath, 'utf-8');
    const articleId = path.match(/^\/article\/([^/]+)$/)?.[1];
    if (!articleId) return indexHtml;

    try {
      const article = await getOne(
        `SELECT id, title, translated_title, tldr, summary_text, raw_excerpt, image_url
         FROM articles
         WHERE id = $1`,
        [decodeURIComponent(articleId)]
      );
      if (!article) return indexHtml;

      const siteUrl = process.env.PUBLIC_SITE_URL || process.env.SITE_URL || new URL(requestUrl).origin;
      const articleUrl = `${siteUrl.replace(/\/$/, '')}/article/${encodeURIComponent(article.id)}`;
      return injectArticleMeta(indexHtml, buildArticleMeta({ article, articleUrl }));
    } catch (err) {
      console.error('Failed to render article metadata:', err);
      return indexHtml;
    }
  };

  app.use('/*', serveStatic({ root: publicDir }));
  // SPA fallback: routes without a file extension return index.html; missing assets return 404.
  app.get('*', async (c) => {
    if (c.req.path.startsWith('/api')) {
      return c.json({ success: false, error: { code: 'NOT_FOUND', message: 'API route not found' } }, 404);
    }
    if (extname(c.req.path)) {
      return c.notFound();
    }
    return c.html(await renderSpaHtml(c.req.path, c.req.url));
  });
} else {
  app.get('/', (c) => c.json({ name: 'News Digest V2 API', version: '1.0.0' }));
}

// Error handler
app.onError((err, c) => {
  console.error('Unhandled error:', err);
  const isProduction = process.env.NODE_ENV === 'production';
  return c.json({
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: isProduction ? 'An unexpected error occurred' : err.message,
    },
  }, 500);
});

// Start server
const port = parseInt(process.env.PORT || '3000');

console.log(`Starting News Digest V2 server on port ${port}...`);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Server running at http://localhost:${info.port}`);

  // Start cron jobs
  startCronJobs();
});

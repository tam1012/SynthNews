import { Context, Next } from 'hono';
import crypto from 'crypto';
import { recordAuthFailure } from './rateLimit.js';

const WEAK_ADMIN_TOKENS = new Set(['', 'change-me', 'change-me-to-a-random-string']);

// Routes that require auth for ALL methods (including GET)
const PROTECTED_PREFIXES = ['/api/ai-providers', '/api/health', '/api/settings', '/api/blocklist', '/api/sources', '/api/articles/fetch-jobs'];
const PUBLIC_GET_PATHS = new Set(['/api/health/live', '/api/sources/public']);

function extractBearerToken(value?: string): string {
  return value?.replace(/^Bearer\s+/i, '').trim() || '';
}

function isWeakAdminToken(token?: string): boolean {
  return WEAK_ADMIN_TOKENS.has((token || '').trim());
}

export function assertAdminTokenConfigured() {
  if (process.env.NODE_ENV !== 'production') return;
  if (isWeakAdminToken(process.env.ADMIN_TOKEN)) {
    throw new Error('ADMIN_TOKEN must be set to a non-default value in production');
  }
}

export function hasValidAdminToken(authHeader?: string): boolean {
  const adminToken = process.env.ADMIN_TOKEN || '';
  const candidate = extractBearerToken(authHeader);
  if (isWeakAdminToken(adminToken) || !candidate) return false;

  const expected = Buffer.from(adminToken);
  const actual = Buffer.from(candidate);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

export function requiresAdminTokenForRequest(method: string, path: string): boolean {
  if (method.toUpperCase() === 'GET' && PUBLIC_GET_PATHS.has(path)) {
    return false;
  }

  const isFullyProtected = PROTECTED_PREFIXES.some(prefix => path.startsWith(prefix));
  if (method.toUpperCase() === 'GET' && !isFullyProtected) {
    return false;
  }

  return true;
}

export async function authMiddleware(c: Context, next: Next) {
  const path = c.req.path;
  const method = c.req.method;

  if (!requiresAdminTokenForRequest(method, path)) {
    return next();
  }

  // Everything else needs token
  if (!hasValidAdminToken(c.req.header('Authorization'))) {
    const rateLimit = recordAuthFailure(c);
    if (!rateLimit.allowed) {
      c.header('Retry-After', String(rateLimit.retryAfterSeconds));
      return c.json({ success: false, error: { code: 'RATE_LIMITED', message: 'Too many invalid token attempts' } }, 429);
    }
    return c.json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Invalid or missing token' } }, 401);
  }

  return next();
}

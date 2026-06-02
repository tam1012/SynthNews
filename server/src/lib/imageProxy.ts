/**
 * Image proxy with on-the-fly resizing + WebP conversion.
 * Downloads the source image once, resizes to the requested preset,
 * converts to WebP, and caches the result on disk so subsequent
 * requests are served instantly without re-processing.
 */
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import sharp from 'sharp';
import { isPrivateHostname, normalizePublicHttpUrlWithDns } from './utils.js';

/* ── Presets ── */
export type ImagePreset = 'thumb' | 'detail' | 'og';

interface PresetConfig {
  width: number;
  height: number;
  quality: number;
}

const PRESETS: Record<ImagePreset, PresetConfig> = {
  thumb:  { width: 240,  height: 160, quality: 60 },
  detail: { width: 800,  height: 600, quality: 72 },
  og:     { width: 1200, height: 630, quality: 75 },
};

/* ── Cache config ── */
const CACHE_DIR = process.env.IMAGE_CACHE_DIR || '/tmp/img-cache';
const MAX_CACHE_SIZE_MB = parseInt(process.env.IMAGE_CACHE_MAX_MB || '200', 10);
const FETCH_TIMEOUT_MS = 8000;
const MAX_SOURCE_BYTES = 10 * 1024 * 1024; // 10 MB source limit
const MAX_SOURCE_PIXELS = 50_000_000;

async function toCacheableUrl(sourceUrl: string): Promise<string> {
  const normalized = await normalizePublicHttpUrlWithDns(sourceUrl);
  if (!normalized) {
    throw new Error('Invalid source image URL');
  }

  const parsed = new URL(normalized);
  if (isPrivateHostname(parsed.hostname)) {
    throw new Error('Private image hosts are not allowed');
  }

  return normalized;
}

/* Ensure cache dir exists */
function ensureCacheDir(): void {
  if (!existsSync(CACHE_DIR)) {
    mkdirSync(CACHE_DIR, { recursive: true });
  }
}

/* ── Cache key ── */
function cacheKey(url: string, preset: ImagePreset): string {
  const hash = createHash('sha256').update(`${preset}:${url}`).digest('hex').slice(0, 16);
  return `${preset}_${hash}.webp`;
}

/* ── Eviction: oldest-first when cache exceeds limit ── */
function evictIfNeeded(): void {
  try {
    const files = readdirSync(CACHE_DIR)
      .map(f => {
        const fullPath = join(CACHE_DIR, f);
        try {
          const stat = statSync(fullPath);
          return { path: fullPath, size: stat.size, mtimeMs: stat.mtimeMs };
        } catch {
          return null;
        }
      })
      .filter(Boolean) as { path: string; size: number; mtimeMs: number }[];

    const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
    if (totalBytes <= MAX_CACHE_SIZE_MB * 1024 * 1024) return;

    // Sort oldest first
    files.sort((a, b) => a.mtimeMs - b.mtimeMs);
    let freed = 0;
    const target = totalBytes - MAX_CACHE_SIZE_MB * 1024 * 1024;
    for (const f of files) {
      if (freed >= target) break;
      try { unlinkSync(f.path); freed += f.size; } catch { /* ignore */ }
    }
  } catch { /* ignore errors during eviction */ }
}

async function readBoundedResponse(response: Response): Promise<Buffer> {
  const contentLength = Number(response.headers.get('content-length') || '0');
  if (Number.isFinite(contentLength) && contentLength > MAX_SOURCE_BYTES) {
    throw new Error(`Source image too large: ${(contentLength / 1024 / 1024).toFixed(1)}MB`);
  }

  if (!response.body) {
    const buf = Buffer.from(await response.arrayBuffer());
    if (buf.length > MAX_SOURCE_BYTES) {
      throw new Error(`Source image too large: ${(buf.length / 1024 / 1024).toFixed(1)}MB`);
    }
    return buf;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      total += value.byteLength;
      if (total > MAX_SOURCE_BYTES) {
        await reader.cancel();
        throw new Error(`Source image too large: ${(total / 1024 / 1024).toFixed(1)}MB`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks);
}

/* ── Main processor ── */
export async function getOptimizedImage(
  sourceUrl: string,
  preset: ImagePreset = 'detail',
): Promise<{ data: Buffer; contentType: string; cacheHit: boolean }> {
  ensureCacheDir();

  const normalizedSourceUrl = await toCacheableUrl(sourceUrl);
  const filename = cacheKey(normalizedSourceUrl, preset);
  const cachePath = join(CACHE_DIR, filename);

  // Cache hit
  if (existsSync(cachePath)) {
    return {
      data: readFileSync(cachePath),
      contentType: 'image/webp',
      cacheHit: true,
    };
  }

  // Download source image
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(normalizedSourceUrl, {
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; SynthNewsBot/1.0)',
        'Accept': 'image/*',
      },
    });
  } finally {
    clearTimeout(timeout);
  }

  if (response.status >= 300 && response.status < 400) {
    throw new Error('Image redirects are not allowed');
  }

  if (!response.ok) {
    throw new Error(`Source returned ${response.status}`);
  }

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.startsWith('image/')) {
    throw new Error(`Not an image: ${contentType}`);
  }

  const buf = await readBoundedResponse(response);

  // Resize + convert
  const config = PRESETS[preset];
  const webpBuf = await sharp(buf, { limitInputPixels: MAX_SOURCE_PIXELS })
    .resize(config.width, config.height, {
      fit: 'inside',
      withoutEnlargement: true,
    })
    .webp({ quality: config.quality })
    .toBuffer();

  // Write to cache
  try {
    writeFileSync(cachePath, webpBuf);
    evictIfNeeded();
  } catch (e) {
    console.warn('[img-proxy] Cache write failed:', e);
  }

  return {
    data: webpBuf,
    contentType: 'image/webp',
    cacheHit: false,
  };
}

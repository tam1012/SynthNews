#!/usr/bin/env node
import { mkdir, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const requireFromServer = createRequire('/app/server/package.json');
const { chromium } = requireFromServer('playwright');

const REUTERS_HOME = 'https://www.reuters.com/';
const DEFAULT_RUNTIME_DIR = process.env.REUTERS_COOKIE_RUNTIME_DIR || '/app/runtime/reuters-cookie';
const PROFILE_DIR = process.env.REUTERS_COOKIE_PROFILE_DIR || path.join(DEFAULT_RUNTIME_DIR, 'profile');
const LOCK_DIR = process.env.REUTERS_COOKIE_LOCK_DIR || path.join(DEFAULT_RUNTIME_DIR, 'refresh.lock');
const DISPLAY = process.env.DISPLAY || ':99';
const READY_FILE = process.env.REUTERS_PROFILE_BROWSER_READY_FILE || path.join(DEFAULT_RUNTIME_DIR, 'manual-browser-ready');

function parseProxyUrl(proxyUrl) {
  if (!proxyUrl) return null;
  const parsed = new URL(proxyUrl);
  const proxy = {
    server: `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}`,
  };
  if (parsed.username) proxy.username = decodeURIComponent(parsed.username);
  if (parsed.password) proxy.password = decodeURIComponent(parsed.password);
  return proxy;
}

async function acquireLock() {
  await mkdir(DEFAULT_RUNTIME_DIR, { recursive: true });
  try {
    await mkdir(LOCK_DIR);
  } catch {
    const lockStat = await stat(LOCK_DIR).catch(() => null);
    const ageMs = lockStat ? Date.now() - lockStat.mtimeMs : 0;
    if (ageMs > 30 * 60 * 1000) {
      await rm(LOCK_DIR, { recursive: true, force: true });
      await mkdir(LOCK_DIR);
      return;
    }
    throw new Error('Reuters cookie profile is locked by another process');
  }
}

async function releaseLock() {
  await rm(LOCK_DIR, { recursive: true, force: true });
}

async function main() {
  await acquireLock();
  const proxy = parseProxyUrl(process.env.SCRAPLING_PROXY_URL || '');
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium-browser';

  console.log(`[reuters-profile-browser] starting proxy=${proxy ? 'SET' : 'EMPTY'} display=${DISPLAY}`);
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    executablePath,
    proxy: proxy || undefined,
    viewport: { width: 1365, height: 900 },
    locale: 'en-US',
    timezoneId: 'Asia/Singapore',
    userAgent: process.env.REUTERS_COOKIE_USER_AGENT || undefined,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  try {
    const page = context.pages()[0] || await context.newPage();
    await page.goto(REUTERS_HOME, { waitUntil: 'domcontentloaded', timeout: 120000 }).catch((error) => {
      console.log(`[reuters-profile-browser] initial navigation failed: ${String(error?.message || error)}`);
    });
    await mkdir(path.dirname(READY_FILE), { recursive: true });
    await import('node:fs/promises').then(({ writeFile }) => writeFile(READY_FILE, new Date().toISOString(), { mode: 0o600 }));
    console.log('[reuters-profile-browser] ready. Open noVNC and complete Reuters/DataDome in this browser profile.');
    await new Promise(() => {});
  } finally {
    await context.close().catch(() => {});
    await releaseLock();
  }
}

process.on('SIGTERM', async () => {
  await releaseLock().catch(() => {});
  process.exit(0);
});

process.on('SIGINT', async () => {
  await releaseLock().catch(() => {});
  process.exit(0);
});

main().catch(async (error) => {
  console.error(`[reuters-profile-browser] failed: ${String(error?.message || error)}`);
  await releaseLock().catch(() => {});
  process.exit(1);
});

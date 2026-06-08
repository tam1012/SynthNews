#!/usr/bin/env node
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const requireFromServer = createRequire('/app/server/package.json');
const { chromium } = requireFromServer('playwright');

const REUTERS_HOME = 'https://www.reuters.com/';
const DEFAULT_RUNTIME_DIR = process.env.REUTERS_COOKIE_RUNTIME_DIR || '/app/runtime/reuters-cookie';
const PROFILE_DIR = process.env.REUTERS_COOKIE_PROFILE_DIR || path.join(DEFAULT_RUNTIME_DIR, 'profile');
const COOKIE_FILE = process.env.REUTERS_COOKIE_HEADER_B64_FILE || path.join(DEFAULT_RUNTIME_DIR, 'reuters-cookie.b64');
const STATUS_FILE = process.env.REUTERS_COOKIE_STATUS_FILE || path.join(DEFAULT_RUNTIME_DIR, 'status.json');
const LOCK_DIR = process.env.REUTERS_COOKIE_LOCK_DIR || path.join(DEFAULT_RUNTIME_DIR, 'refresh.lock');
const LOG_FILE = process.env.REUTERS_COOKIE_LOG_FILE || path.join(DEFAULT_RUNTIME_DIR, 'refresh.log');
const COOLDOWN_SECONDS = parsePositiveInt(process.env.REUTERS_COOKIE_REFRESH_COOLDOWN_SECONDS, 900);
const TIMEOUT_MS = parsePositiveInt(process.env.REUTERS_COOKIE_REFRESH_TIMEOUT_MS, 90000);
const MIN_COOKIE_HEADER_LENGTH = parsePositiveInt(process.env.REUTERS_COOKIE_MIN_HEADER_LENGTH, 120);
const VERIFY_URL = process.env.REUTERS_COOKIE_VERIFY_URL || 'https://www.reuters.com/world/';
const KEEP_BROWSER_OPEN = process.env.REUTERS_COOKIE_KEEP_BROWSER_OPEN === 'true';
const DRY_RUN = process.argv.includes('--dry-run') || process.env.REUTERS_COOKIE_DRY_RUN === 'true';

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function maskMessage(error) {
  return String(error?.message || error || 'unknown error').replace(/([?&](?:token|key|password|cookie)=)[^&\s]+/gi, '$1[redacted]');
}

async function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  await mkdir(path.dirname(LOG_FILE), { recursive: true });
  await writeFile(LOG_FILE, `${line}\n`, { flag: 'a', mode: 0o600 });
}

async function writeStatus(status, extra = {}) {
  await mkdir(path.dirname(STATUS_FILE), { recursive: true });
  await writeFile(STATUS_FILE, JSON.stringify({
    status,
    updatedAt: new Date().toISOString(),
    ...extra,
  }, null, 2), { mode: 0o600 });
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
    throw new Error('refresh already running');
  }
}

async function releaseLock() {
  await rm(LOCK_DIR, { recursive: true, force: true });
}

async function assertCooldown() {
  const status = await readStatus().catch(() => null);
  if (!status?.updatedAt || status.status !== 'ok') return;
  const elapsedSeconds = Math.floor((Date.now() - new Date(status.updatedAt).getTime()) / 1000);
  if (elapsedSeconds < COOLDOWN_SECONDS) {
    await log(`refresh:skip cooldown active (${elapsedSeconds}s elapsed, need ${COOLDOWN_SECONDS}s)`);
    process.exitCode = 0;
    throw new CooldownSkip();
  }
}

class CooldownSkip extends Error {
  constructor() {
    super('cooldown active');
    this.name = 'CooldownSkip';
  }
}

async function readStatus() {
  return JSON.parse(await readFile(STATUS_FILE, 'utf8'));
}

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

function buildCookieHeader(cookies) {
  return cookies
    .filter((cookie) => {
      const domain = String(cookie.domain || '').replace(/^\./, '').toLowerCase();
      return cookie.name && cookie.value && (domain === 'reuters.com' || domain.endsWith('.reuters.com'));
    })
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ');
}

function cookieHeaderToContextCookies(cookieHeader) {
  return String(cookieHeader || '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.includes('='))
    .map((part) => {
      const eq = part.indexOf('=');
      return {
        name: part.slice(0, eq).trim(),
        value: part.slice(eq + 1).trim(),
        url: REUTERS_HOME,
        secure: true,
      };
    })
    .filter((cookie) => {
      if (!cookie.name || !cookie.value) return false;
      if (/[\u0000-\u001f\u007f()<>@,;:\\"/[\\]?={} \t]/.test(cookie.name)) return false;
      if (/[\u0000-\u001f\u007f;]/.test(cookie.value)) return false;
      return true;
    });
}

async function readEncodedCookieFromFile(filePath) {
  if (!filePath) return null;
  try {
    const encoded = (await readFile(filePath, 'utf8')).trim();
    const decoded = Buffer.from(encoded, 'base64').toString('utf8').trim();
    return decoded || null;
  } catch {
    return null;
  }
}

async function readBootstrapCookieHeader() {
  const fromFile = await readEncodedCookieFromFile(COOKIE_FILE);
  if (fromFile) return fromFile;

  const encoded = process.env.REUTERS_COOKIE_HEADER_B64?.trim();
  if (encoded) {
    try {
      const decoded = Buffer.from(encoded, 'base64').toString('utf8').trim();
      if (decoded) return decoded;
    } catch {}
  }

  const plain = process.env.REUTERS_COOKIE_HEADER?.trim();
  return plain || null;
}

function isBlockedHtml(html) {
  const lowered = String(html || '').toLowerCase();
  return lowered.includes('datadome') ||
    lowered.includes('captcha-delivery.com') ||
    lowered.includes('enable javascript and cookies') ||
    lowered.includes('access denied');
}

async function atomicWriteCookie(cookieHeader) {
  const encoded = Buffer.from(cookieHeader, 'utf8').toString('base64');
  await mkdir(path.dirname(COOKIE_FILE), { recursive: true });

  if (existsSync(COOKIE_FILE)) {
    const backupPath = `${COOKIE_FILE}.${new Date().toISOString().replace(/[:.]/g, '-')}.bak`;
    await writeFile(backupPath, await readFile(COOKIE_FILE), { mode: 0o600 });
  }

  const tempPath = `${COOKIE_FILE}.tmp-${process.pid}`;
  await writeFile(tempPath, encoded, { mode: 0o600 });
  await rename(tempPath, COOKIE_FILE);
}

async function verifyPage(page) {
  const response = await page.goto(VERIFY_URL, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
  await page.waitForTimeout(5000);
  const html = await page.content();
  return {
    ok: Boolean(response?.ok()) && !isBlockedHtml(html) && html.length > 5000,
    status: response?.status() || 0,
    htmlLength: html.length,
    blocked: isBlockedHtml(html),
  };
}

async function refreshReutersCookie() {
  const proxy = parseProxyUrl(process.env.SCRAPLING_PROXY_URL || '');
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium-browser';

  await log(`refresh:start proxy=${proxy ? 'SET' : 'EMPTY'} dryRun=${DRY_RUN}`);

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: process.env.REUTERS_COOKIE_HEADLESS !== 'false',
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
    const bootstrapCookieHeader = await readBootstrapCookieHeader();
    const bootstrapCookies = cookieHeaderToContextCookies(bootstrapCookieHeader);
    if (bootstrapCookies.length > 0) {
      let acceptedCookies = 0;
      for (const cookie of bootstrapCookies) {
        try {
          await context.addCookies([cookie]);
          acceptedCookies += 1;
        } catch {}
      }
      await log(`refresh:bootstrap cookies=${acceptedCookies}/${bootstrapCookies.length}`);
    }

    const page = context.pages()[0] || await context.newPage();
    await page.goto(REUTERS_HOME, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
    await page.waitForTimeout(7000);

    for (const selector of [
      'button:has-text("Accept")',
      'button:has-text("I agree")',
      'button[aria-label*="Accept"]',
      '#onetrust-accept-btn-handler',
    ]) {
      await page.locator(selector).first().click({ timeout: 2000 }).catch(() => {});
    }

    const verify = await verifyPage(page);
    const cookies = await context.cookies();
    const cookieHeader = buildCookieHeader(cookies);

    if (cookieHeader.length < MIN_COOKIE_HEADER_LENGTH) {
      throw new Error(`cookie header too short (${cookieHeader.length})`);
    }
    if (!verify.ok) {
      throw new Error(`verify failed status=${verify.status} blocked=${verify.blocked} htmlLength=${verify.htmlLength}`);
    }

    if (!DRY_RUN) {
      await atomicWriteCookie(cookieHeader);
    }

    await writeStatus('ok', {
      cookieHeaderLength: cookieHeader.length,
      verify,
      dryRun: DRY_RUN,
    });
    await log(`refresh:ok cookieHeaderLength=${cookieHeader.length} verifyStatus=${verify.status}`);
  } finally {
    if (!KEEP_BROWSER_OPEN) {
      await context.close();
    }
  }
}

async function main() {
  await acquireLock();
  try {
    await assertCooldown();
    await refreshReutersCookie();
  } catch (error) {
    if (error instanceof CooldownSkip) return;
    const message = maskMessage(error);
    await writeStatus('failed', { error: message });
    await log(`refresh:failed ${message}`);
    process.exitCode = 1;
  } finally {
    await releaseLock();
  }
}

main().catch(async (error) => {
  await log(`refresh:fatal ${maskMessage(error)}`).catch(() => {});
  process.exit(1);
});

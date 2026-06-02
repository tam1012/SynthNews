import { nanoid } from 'nanoid';
import { createHash } from 'crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export function generateId(prefix?: string): string {
  const id = nanoid(16);
  return prefix ? `${prefix}_${id}` : id;
}

export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength) + '...';
}

export function createContentHash(content: string): string {
  return createHash('sha256').update(content.trim().toLowerCase()).digest('hex').slice(0, 32);
}

export function normalizeUrl(url: string, stripTrailingSlash = true): string {
  try {
    const u = new URL(url);
    // Loai bo fragment, tracking params
    u.hash = '';
    u.searchParams.delete('utm_source');
    u.searchParams.delete('utm_medium');
    u.searchParams.delete('utm_campaign');
    u.searchParams.delete('utm_content');
    u.searchParams.delete('utm_term');
    u.searchParams.delete('fbclid');
    u.searchParams.delete('ref');
    
    if (stripTrailingSlash) {
      let path = u.pathname.replace(/\/+$/, '') || '/';
      u.pathname = path;
    }
    return u.toString();
  } catch {
    return url;
  }
}

function stripIpBrackets(value: string): string {
  const host = value.trim().toLowerCase();
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

function parseIpv4Parts(value: string): number[] | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  const nums = parts.map((part) => Number(part));
  if (nums.some((part, idx) => !/^\d{1,3}$/.test(parts[idx]) || part < 0 || part > 255)) return null;
  return nums;
}

function isBlockedIpv4(value: string): boolean {
  const parts = parseIpv4Parts(value);
  if (!parts) return false;
  const [a, b, c] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function parseIpv6Piece(piece: string): number[] | null {
  if (!piece) return [];
  if (piece.includes('.')) {
    const ipv4 = parseIpv4Parts(piece);
    if (!ipv4) return null;
    return [(ipv4[0] << 8) + ipv4[1], (ipv4[2] << 8) + ipv4[3]];
  }
  if (!/^[0-9a-f]{1,4}$/i.test(piece)) return null;
  return [parseInt(piece, 16)];
}

function parseIpv6Hextets(value: string): number[] | null {
  const host = stripIpBrackets(value);
  if (host.includes('%')) return null;
  const halves = host.split('::');
  if (halves.length > 2) return null;

  const parseSide = (side: string): number[] | null => {
    if (!side) return [];
    const hextets: number[] = [];
    for (const piece of side.split('.').length > 4 ? [side] : side.split(':')) {
      const parsed = parseIpv6Piece(piece);
      if (!parsed) return null;
      hextets.push(...parsed);
    }
    return hextets;
  };

  const left = parseSide(halves[0]);
  const right = parseSide(halves[1] || '');
  if (!left || !right) return null;

  if (halves.length === 1) return left.length === 8 ? left : null;
  const fill = 8 - left.length - right.length;
  if (fill < 1) return null;
  return [...left, ...Array(fill).fill(0), ...right];
}

function isBlockedIpv6(value: string): boolean {
  const hextets = parseIpv6Hextets(value);
  if (!hextets) return true;
  const bytes = hextets.flatMap((part) => [(part >> 8) & 0xff, part & 0xff]);
  const allZero = bytes.every((byte) => byte === 0);
  const loopback = bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1;
  const ipv4Mapped = bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  const ipv4Compatible = bytes.slice(0, 12).every((byte) => byte === 0);
  if (ipv4Mapped || ipv4Compatible) {
    return isBlockedIpv4(bytes.slice(12).join('.'));
  }
  return (
    allZero ||
    loopback ||
    (bytes[0] & 0xfe) === 0xfc ||
    (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) ||
    bytes[0] === 0xff ||
    (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8)
  );
}

function looksLikeObfuscatedIp(hostname: string): boolean {
  const host = hostname.toLowerCase();
  const parts = host.split('.');
  const compact = parts.join('');
  return compact.length > 0 && (
    /^\d+$/.test(compact) ||
    host.startsWith('0x') ||
    parts.some((part) => part.startsWith('0x'))
  );
}

export function isBlockedIpAddress(address: string): boolean {
  const host = stripIpBrackets(address);
  if (isIP(host) === 4) return isBlockedIpv4(host);
  if (isIP(host) === 6) return isBlockedIpv6(host);
  return true;
}

export function isPrivateHostname(hostname: string): boolean {
  const host = stripIpBrackets(hostname);
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host.includes('%')) return true;
  if (isIP(host)) return isBlockedIpAddress(host);
  return looksLikeObfuscatedIp(host);
}

export function normalizePublicHttpUrl(url: string, stripTrailingSlash = true): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (isPrivateHostname(u.hostname)) return null;
    return normalizeUrl(u.toString(), stripTrailingSlash);
  } catch {
    return null;
  }
}

type LookupAddress = { address: string };
type PublicDnsLookup = (hostname: string) => Promise<LookupAddress | LookupAddress[]>;

async function defaultPublicDnsLookup(hostname: string): Promise<LookupAddress[]> {
  return dnsLookup(hostname, { all: true, verbatim: true });
}

export async function normalizePublicHttpUrlWithDns(
  url: string,
  stripTrailingSlash = true,
  lookupFn: PublicDnsLookup = defaultPublicDnsLookup,
): Promise<string | null> {
  const normalized = normalizePublicHttpUrl(url, stripTrailingSlash);
  if (!normalized) return null;

  const hostname = new URL(normalized).hostname;
  const host = stripIpBrackets(hostname);
  if (isIP(host)) return isBlockedIpAddress(host) ? null : normalized;

  try {
    const result = await lookupFn(host);
    const addresses = Array.isArray(result) ? result : [result];
    if (addresses.length === 0) return null;
    if (addresses.some((entry) => !entry?.address || isBlockedIpAddress(entry.address))) return null;
    return normalized;
  } catch {
    return null;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

import { createReadStream, existsSync, readdirSync } from 'fs';
import { createInterface } from 'readline';
import { createGunzip } from 'zlib';
import { join } from 'path';

const LOG_DIR = process.env.NGINX_ACCESS_LOG_DIR || '/var/log/nginx';
const LOG_BASENAME = 'access.log';
// Bo qua chinh IP cua VPS (node tu goi, uptime-kuma, healthcheck noi bo)
const INTERNAL_IPS = new Set(['127.0.0.1', '::1', '158.178.239.119']);
// Toi da so dong parse trong 1 lan goi de tranh ngon CPU/RAM khi range rong
const MAX_LINES = 600_000;

const MONTHS: Record<string, string> = {
  Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
  Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
};

// Mau combined log: IP - - [10/Jun/2026:14:11:08 +0700] "GET /path HTTP/1.1" 200 1234 "ref" "UA"
const LINE_RE = /^(\S+) \S+ \S+ \[(\d{2})\/([A-Za-z]{3})\/(\d{4}):[^\]]+\] "([A-Z]+) ([^"]*?) [^"]*" (\d{3}) \S+ "[^"]*" "([^"]*)"/;

const BOT_UA_RE = /bot|crawl|spider|slurp|bingpreview|mediapartners|facebookexternalhit|embedly|monitor|uptime|pingdom|headless|python-requests|curl|wget|go-http|node|axios|okhttp|java\/|libwww|scrapy|semrush|ahrefs|dotbot|petalbot/i;

export type ParsedLogLine = {
  ip: string;
  date: string; // YYYY-MM-DD theo gio trong log (+0700)
  method: string;
  path: string;
  status: number;
  isBot: boolean;
  isInternal: boolean;
};

function parseLine(line: string): ParsedLogLine | null {
  const m = LINE_RE.exec(line);
  if (!m) return null;
  const [, ip, day, monAbbr, year, method, path, statusStr, ua] = m;
  const mon = MONTHS[monAbbr];
  if (!mon) return null;
  return {
    ip,
    date: `${year}-${mon}-${day}`,
    method,
    path,
    status: Number(statusStr),
    isBot: BOT_UA_RE.test(ua),
    isInternal: INTERNAL_IPS.has(ip),
  };
}

// Tra ve danh sach file log theo thu tu moi -> cu: access.log, access.log.1, access.log.2.gz, ...
function listLogFiles(): string[] {
  if (!existsSync(LOG_DIR)) return [];
  const files = readdirSync(LOG_DIR).filter((f) => f === LOG_BASENAME || f.startsWith(`${LOG_BASENAME}.`));
  const indexOf = (f: string): number => {
    if (f === LOG_BASENAME) return 0;
    const m = /\.(\d+)(\.gz)?$/.exec(f);
    return m ? Number(m[1]) : 9999;
  };
  return files.sort((a, b) => indexOf(a) - indexOf(b)).map((f) => join(LOG_DIR, f));
}

async function readLogFileLines(path: string, onLine: (line: string) => void): Promise<void> {
  const stream = path.endsWith('.gz')
    ? createReadStream(path).pipe(createGunzip())
    : createReadStream(path);
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    onLine(line);
  }
}

export type VisitAggregation = {
  available: boolean;
  reason?: string;
  daily: { date: string; total: number; humans: number; suspectedBots: number; uniqueIps: number }[];
  topIps: { ip: string; total: number; humans: number; suspectedBot: number; bot: number; paths: number }[];
  totals: {
    requests: number;
    humanRequests: number;
    suspectedBotRequests: number;
    botRequests: number;
    uniqueIps: number;
    uniqueHumanIps: number;
    uniqueSuspectedBotIps: number;
  };
};

// Doc + gop log trong khoang [from, to] (YYYY-MM-DD). Dung som khi gap file chi chua ngay cu hon from.
export async function aggregateVisits(from: string, to: string): Promise<VisitAggregation> {
  const files = listLogFiles();
  if (files.length === 0) {
    return {
      available: false,
      reason: `Không tìm thấy log nginx tại ${LOG_DIR}. Cần mount thư mục log vào container.`,
      daily: [],
      topIps: [],
      totals: {
        requests: 0,
        humanRequests: 0,
        suspectedBotRequests: 0,
        botRequests: 0,
        uniqueIps: 0,
        uniqueHumanIps: 0,
        uniqueSuspectedBotIps: 0,
      },
    };
  }

  const dailyMap = new Map<string, { total: number; humans: number; suspectedBots: number; ips: Set<string> }>();
  const ipMap = new Map<string, { total: number; humans: number; bot: number; paths: Set<string> }>();
  const dailyIpMap = new Map<string, Map<string, { total: number; humans: number }>>();

  let requests = 0;
  const uniqueIps = new Set<string>();
  let linesParsed = 0;
  let truncated = false;

  for (const file of files) {
    let fileHadOlder = false;
    try {
      await readLogFileLines(file, (line) => {
        if (linesParsed >= MAX_LINES) { truncated = true; return; }
        const parsed = parseLine(line);
        if (!parsed) return;
        linesParsed++;
        if (parsed.date < from) { fileHadOlder = true; return; }
        if (parsed.date > to) return;
        if (parsed.isInternal) return;

        requests++;
        uniqueIps.add(parsed.ip);
        const human = !parsed.isBot;

        const ipRow = ipMap.get(parsed.ip) || { total: 0, humans: 0, bot: 0, paths: new Set<string>() };
        ipRow.total++;
        if (human) ipRow.humans++; else ipRow.bot++;
        if (ipRow.paths.size < 50) ipRow.paths.add(parsed.path);
        ipMap.set(parsed.ip, ipRow);

        if (!dailyIpMap.has(parsed.date)) {
          dailyIpMap.set(parsed.date, new Map());
        }
        const dayIpMap = dailyIpMap.get(parsed.date)!;
        const dayIpRow = dayIpMap.get(parsed.ip) || { total: 0, humans: 0 };
        dayIpRow.total++;
        if (human) dayIpRow.humans++;
        dayIpMap.set(parsed.ip, dayIpRow);
      });
    } catch {
      // File loi (vd .gz hong) thi bo qua, tiep tuc file khac
      continue;
    }
    // File nay da chua ngay cu hon from -> cac file con lai (cu hon) khong can doc
    if (fileHadOlder || truncated) break;
  }

  // Tinh so ngay trong khoang de dat nguong bot phu hop (trung binh > 50 request/ngay hoac toi thieu 100 request)
  const fromMs = new Date(`${from}T00:00:00Z`).getTime();
  const toMs = new Date(`${to}T00:00:00Z`).getTime();
  const daysCount = Math.max(1, Math.round((toMs - fromMs) / (24 * 60 * 60 * 1000)) + 1);
  const suspectedThreshold = Math.max(100, daysCount * 50);

  const suspectedBotIps = new Set<string>();
  for (const [ip, stats] of ipMap.entries()) {
    // Neu IP khong phai bot theo UA nhung co luot request human vuot nguong thi nghi ngo la bot
    if (stats.humans > 0 && stats.total > suspectedThreshold) {
      suspectedBotIps.add(ip);
    }
  }

  let finalHumanRequests = 0;
  let finalSuspectedBotRequests = 0;
  let finalBotRequests = 0;
  const finalUniqueHumanIps = new Set<string>();
  const finalUniqueSuspectedBotIps = new Set<string>();

  for (const [ip, stats] of ipMap.entries()) {
    if (suspectedBotIps.has(ip)) {
      finalSuspectedBotRequests += stats.total;
      finalUniqueSuspectedBotIps.add(ip);
    } else {
      finalHumanRequests += stats.humans;
      finalBotRequests += stats.bot;
      if (stats.humans > 0) finalUniqueHumanIps.add(ip);
    }
  }

  for (const [date, dayIpMap] of dailyIpMap.entries()) {
    let dayTotal = 0;
    let dayHumans = 0;
    let daySuspectedBots = 0;
    const dayIps = new Set<string>();

    for (const [ip, stats] of dayIpMap.entries()) {
      dayTotal += stats.total;
      dayIps.add(ip);
      if (suspectedBotIps.has(ip)) {
        daySuspectedBots += stats.total;
      } else {
        dayHumans += stats.humans;
      }
    }
    dailyMap.set(date, {
      total: dayTotal,
      humans: dayHumans,
      suspectedBots: daySuspectedBots,
      ips: dayIps,
    });
  }

  const daily = Array.from(dailyMap.entries())
    .map(([date, v]) => ({ date, total: v.total, humans: v.humans, suspectedBots: v.suspectedBots, uniqueIps: v.ips.size }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const topIps = Array.from(ipMap.entries())
    .map(([ip, v]) => ({
      ip,
      total: v.total,
      humans: suspectedBotIps.has(ip) ? 0 : v.humans,
      suspectedBot: suspectedBotIps.has(ip) ? v.total : 0,
      bot: v.bot,
      paths: v.paths.size,
    }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 30);

  return {
    available: true,
    reason: truncated ? `Đã đạt giới hạn ${MAX_LINES.toLocaleString('en-US')} dòng log, số liệu có thể thiếu phần cũ nhất.` : undefined,
    daily,
    topIps,
    totals: {
      requests,
      humanRequests: finalHumanRequests,
      suspectedBotRequests: finalSuspectedBotRequests,
      botRequests: finalBotRequests,
      uniqueIps: uniqueIps.size,
      uniqueHumanIps: finalUniqueHumanIps.size,
      uniqueSuspectedBotIps: finalUniqueSuspectedBotIps.size,
    },
  };
}

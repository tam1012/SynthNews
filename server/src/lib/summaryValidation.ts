import type { ParsedSummaryOutput } from './summaryOutput.js';

function hasRepetitiveVietnamTimezoneConversions(text: string): boolean {
  const blocks = text
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);

  return blocks.some((block) => {
    const mentions = block.match(/giờ\s+Việt\s+Nam/giu) || [];
    const conversionParentheticals = block.match(/\([^)]*(?:tức|khoảng)[^)]*giờ\s+Việt\s+Nam[^)]*\)/giu) || [];
    return mentions.length >= 3 && conversionParentheticals.length >= 3;
  });
}

function normalizeRepeatedAmount(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .replace(/[.,](?=\d{3}\b)/g, '')
    .trim();
}

function hasRepetitiveVndConversions(text: string): boolean {
  const blocks = text
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);

  const conversionPattern = /((?:[$€£¥]\s*)?\d[\d.,]*(?:\s*(?:nghìn|triệu|tỷ|thousand|million|billion))?(?:\s*(?:nhân\s+dân\s+tệ|ndt|cny|yuan|renminbi|usd|eur|gbp|jpy|đô\s+la|euro|yên))?)\s*\([^)]*(?:khoảng|tương\s+đương)[^)]*(?:vnđ|vnd|đồng)[^)]*\)/giu;

  return blocks.some((block) => {
    const seen = new Map<string, number>();
    for (const match of block.matchAll(conversionPattern)) {
      const key = normalizeRepeatedAmount(match[1] || '');
      if (!key) continue;
      const count = (seen.get(key) || 0) + 1;
      if (count >= 3) return true;
      seen.set(key, count);
    }
    return false;
  });
}

export function assertUsableSummaryOutput(parsed: ParsedSummaryOutput, stage: string): ParsedSummaryOutput {
  const markdown = String(parsed.editorialMarkdown || '').trim();
  const tldr = String(parsed.tldr || '').trim();
  const summaryShort = String(parsed.summaryShort || '').trim();
  const combinedText = [tldr, summaryShort, markdown].join('\n\n');

  if (!parsed.isUsable || !markdown || !tldr) {
    throw new Error(
      `AI summary output unusable after ${stage}: isUsable=${parsed.isUsable}, tldrLength=${tldr.length}, markdownLength=${markdown.length}`
    );
  }

  if (hasRepetitiveVietnamTimezoneConversions(combinedText)) {
    throw new Error(`AI summary output suspicious repetitive Vietnam timezone conversions after ${stage}`);
  }

  if (hasRepetitiveVndConversions(combinedText)) {
    throw new Error(`AI summary output suspicious repetitive VND conversions after ${stage}`);
  }

  return parsed;
}

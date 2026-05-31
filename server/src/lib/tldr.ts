const ELLIPSIS = '...';

export function stripTldrMarkup(text: string): string {
  return text
    .replace(/<[^>]+>/g, ' ')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^#+\s+/gm, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_`>#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeTldr(tldr: string, maxChars = 200): string {
  const cleaned = stripTldrMarkup(tldr);
  if (!cleaned) return '';
  if (cleaned.length <= maxChars) return cleaned;

  const minSentenceChars = Math.min(70, Math.max(40, maxChars - 80));
  const sentence = cleaned.match(new RegExp(`^(.{${minSentenceChars},${maxChars}}?[.!?])\\s`))?.[1];
  if (sentence) return sentence.trim();

  const cutLimit = Math.max(1, maxChars - ELLIPSIS.length);
  const cut = cleaned.slice(0, cutLimit);
  const lastSpace = cut.lastIndexOf(' ');
  return `${cut.slice(0, lastSpace > 80 ? lastSpace : cutLimit).trim()}${ELLIPSIS}`;
}

export function makeTldrFromSummary(summaryText: string, maxChars = 200): string {
  const cleaned = stripTldrMarkup(summaryText);
  if (!cleaned) return '';

  const firstSentence = cleaned.match(/^(.{40,180}?[.!?])\s/)?.[1];
  return normalizeTldr(firstSentence || cleaned, maxChars);
}

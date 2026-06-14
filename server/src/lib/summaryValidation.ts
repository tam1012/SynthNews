import type { ParsedSummaryOutput } from './summaryOutput.js';

export function assertUsableSummaryOutput(parsed: ParsedSummaryOutput, stage: string): ParsedSummaryOutput {
  const markdown = String(parsed.editorialMarkdown || '').trim();
  const tldr = String(parsed.tldr || '').trim();

  if (!parsed.isUsable || !markdown || !tldr) {
    throw new Error(
      `AI summary output unusable after ${stage}: isUsable=${parsed.isUsable}, tldrLength=${tldr.length}, markdownLength=${markdown.length}`
    );
  }

  return parsed;
}

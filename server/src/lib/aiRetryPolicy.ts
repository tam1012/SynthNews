export const RETRYABLE_AI_ERROR_SQL_PATTERNS = [
  '%timeout%',
  '%timed out%',
  '%aborted%',
  '%408%',
  '%429%',
  '%500%',
  '%502%',
  '%503%',
  '%504%',
  '%524%',
  '%rate limit%',
  '%too many requests%',
  '%econnreset%',
  '%etimedout%',
  '%socket hang up%',
  '%<!doctype html%',
];

export function isRetryableAiError(err: unknown): boolean {
  const message = String(err instanceof Error ? err.message : err || '').toLowerCase();
  if (/\b(408|429|500|502|503|504|524)\b/.test(message)) return true;
  return message.includes('rate limit') ||
    message.includes('too many requests') ||
    message.includes('timeout') ||
    message.includes('timed out') ||
    message.includes('aborted') ||
    message.includes('econnreset') ||
    message.includes('etimedout') ||
    message.includes('socket hang up') ||
    message.includes('<!doctype html');
}

export interface FetchJobErrorClassification {
  type: 'timeout' | 'rate_limited' | 'server_error' | 'connection' | 'blocked' | 'not_found' | 'invalid_url' | 'unknown';
  retryable: boolean;
  httpStatus: number | null;
}

function extractHttpStatus(message: string): number | null {
  const match = message.match(/\b(400|401|403|404|408|410|429|500|502|503|504|524)\b/);
  return match ? Number(match[1]) : null;
}

export function classifyFetchJobError(err: unknown): FetchJobErrorClassification {
  const message = String(err instanceof Error ? err.message : err || '').toLowerCase();
  const httpStatus = extractHttpStatus(message);

  if (message.includes('url must be a public http') || message.includes('invalid url')) {
    return { type: 'invalid_url', retryable: false, httpStatus };
  }
  if (httpStatus === 404 || httpStatus === 410) {
    return { type: 'not_found', retryable: false, httpStatus };
  }
  if (httpStatus === 408 || httpStatus === 429) {
    return { type: httpStatus === 429 ? 'rate_limited' : 'timeout', retryable: true, httpStatus };
  }
  if ([500, 502, 503, 504, 524].includes(httpStatus || 0)) {
    return { type: 'server_error', retryable: true, httpStatus };
  }
  if (message.includes('timeout') || message.includes('timed out') || message.includes('aborted')) {
    return { type: 'timeout', retryable: true, httpStatus };
  }
  if (message.includes('econnreset') || message.includes('etimedout') || message.includes('socket hang up')) {
    return { type: 'connection', retryable: true, httpStatus };
  }
  if (message.includes('blocked') || message.includes('cloudflare') || message.includes('datadome') || message.includes('challenge')) {
    return { type: 'blocked', retryable: true, httpStatus };
  }

  return { type: 'unknown', retryable: true, httpStatus };
}

export function buildNullArticleSkipReason(sourceType: string): string {
  return `fetcher returned no article for ${sourceType || 'unknown'} source`;
}

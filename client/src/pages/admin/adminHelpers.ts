export type AiProviderFormData = {
  name: string;
  provider_type: string;
  model: string;
  api_endpoint: string;
  api_key: string;
  max_tokens: number;
  temperature: string;
  extra_config: string;
};

export type PromptConfigFormData = {
  output_language: string;
  topic_priorities: string;
  allowed_tags: string;
  digest_headings: string;
  custom_context: string;
};

export type AdminTab = 'overview' | 'queue' | 'quality' | 'fetchJobs' | 'ai' | 'prompt' | 'blocklist';
export type SummaryQueueStatus = 'failed' | 'pending' | 'processing' | 'skipped' | 'done';
export type QualityIssue = 'missing_tldr' | 'missing_summary_short' | 'missing_tags' | 'missing_hot_score' | 'short_summary';
export type FetchJobStatus = 'failed' | 'discovered' | 'fetching' | 'done';
export type AdminWorkItemSeverity = 'critical' | 'warning' | 'info' | 'ok';
export type AdminWorkItemTarget =
  | 'sources'
  | 'quality'
  | 'queue:failed'
  | 'queue:pending'
  | 'queue:processing'
  | 'queue:skipped'
  | 'fetch:failed'
  | 'fetch:discovered'
  | 'fetch:fetching';
export type AdminWorkItemRunAction = 'scrape' | 'fetch-articles' | 'summarize' | 'digest';
export type AdminWorkItem = {
  label: string;
  value: number | string;
  note: string;
  severity: AdminWorkItemSeverity;
  target?: AdminWorkItemTarget;
  runAction?: AdminWorkItemRunAction;
  actionLabel?: string;
};

export const AI_PROVIDER_TYPES = [
  { value: 'custom', label: 'OpenAI-compatible / 9router' },
  { value: 'anthropic', label: 'Anthropic-compatible' },
  { value: 'vertex_ai_key', label: 'Vertex AI API key' },
  { value: 'openai_responses', label: 'OpenAI Responses' },
];
export const AI_PROVIDER_PRESETS = [
  {
    label: '9router VPS',
    data: { provider_type: 'custom', model: '', api_endpoint: 'http://host.docker.internal:20128/v1', max_tokens: 4096, temperature: '0.3', extra_config: '{\n  "format": "openai"\n}' },
  },
  {
    label: 'Add OpenAI Compatible',
    data: { provider_type: 'custom', model: '', api_endpoint: '', max_tokens: 4096, temperature: '0.3', extra_config: '{\n  "format": "openai"\n}' },
  },
  {
    label: 'Add Anthropic Compatible',
    data: { provider_type: 'anthropic', model: '', api_endpoint: '', max_tokens: 4096, temperature: '0.3', extra_config: '' },
  },
  {
    label: 'Vertex AI API key',
    data: { provider_type: 'vertex_ai_key', model: 'gemini-3-flash-preview', api_endpoint: '', max_tokens: 4096, temperature: '0.3', extra_config: '' },
  },
];
export const SUMMARY_QUEUE_STATUSES: { key: SummaryQueueStatus; label: string }[] = [
  { key: 'failed', label: 'Lỗi' },
  { key: 'pending', label: 'Chờ' },
  { key: 'processing', label: 'Đang chạy' },
  { key: 'skipped', label: 'Bỏ qua' },
  { key: 'done', label: 'Đã xong' },
];
export const FETCH_JOB_STATUSES: { key: FetchJobStatus; label: string }[] = [
  { key: 'failed', label: 'Lỗi' },
  { key: 'discovered', label: 'Chờ fetch' },
  { key: 'fetching', label: 'Đang fetch' },
  { key: 'done', label: 'Đã xong' },
];
export const QUALITY_ISSUES: { key: QualityIssue; label: string }[] = [
  { key: 'missing_tldr', label: 'Thiếu TL;DR' },
  { key: 'missing_summary_short', label: 'Thiếu tóm tắt ngắn' },
  { key: 'missing_tags', label: 'Thiếu nhãn' },
  { key: 'missing_hot_score', label: 'Thiếu điểm nóng' },
  { key: 'short_summary', label: 'Tóm tắt quá ngắn' },
];

export function createEmptyAiProviderForm(): AiProviderFormData {
  return {
    name: '',
    provider_type: 'custom',
    model: '',
    api_endpoint: '',
    api_key: '',
    max_tokens: 4096,
    temperature: '0.3',
    extra_config: '{\n  "format": "openai"\n}',
  };
}

export function aiProviderHelp(type: string): string {
  if (type === 'custom') return 'Dùng cho 9router/OpenAI-compatible. 9router VPS chỉ cần model; custom ngoài cần API key + endpoint.';
  if (type === 'anthropic') return 'Dùng API Anthropic Messages-compatible: nhập API key, model, endpoint nếu không dùng endpoint mặc định Anthropic.';
  if (type === 'vertex_ai_key') return 'Dùng Vertex AI API key: nhập API key và model Gemini, để trống endpoint để dùng mặc định.';
  if (type === 'openai_responses') return 'Dùng OpenAI Responses API: nhập OpenAI API key và model.';
  return '';
}

export function formatExtraConfig(value: unknown): string {
  if (!value) return '';
  if (typeof value === 'string') {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '';
  }
}

export function numberText(value: unknown): string {
  return String(Number(value || 0));
}

const ADMIN_WORK_SEVERITY_ORDER: Record<AdminWorkItemSeverity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
  ok: 3,
};

function asCount(value: unknown): number {
  const count = Number(value || 0);
  return Number.isFinite(count) ? count : 0;
}

function sortAdminWorkItems(items: AdminWorkItem[]): AdminWorkItem[] {
  return items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.severity === 'ok' || asCount(item.value) > 0 || typeof item.value === 'string')
    .sort((a, b) => {
      const severity = ADMIN_WORK_SEVERITY_ORDER[a.item.severity] - ADMIN_WORK_SEVERITY_ORDER[b.item.severity];
      if (severity !== 0) return severity;
      return a.index - b.index;
    })
    .map(({ item }) => item);
}

export function buildAdminWorkItems(health: any): AdminWorkItem[] {
  const publicChecks = Array.isArray(health?.publicChecks) ? health.publicChecks : [];
  const hasPublicCheckFailure = publicChecks.some((check: any) => check.status !== 'ok');
  const needsBrowser = Array.isArray(health?.browserProxy?.sources)
    ? health.browserProxy.sources.some((source: any) => source.needsBrowser)
    : Boolean(health?.vozProxy?.needsBrowser);

  const items: AdminWorkItem[] = [];

  if (health?.runtime && health.runtime.dbReachable === false) {
    items.push({
      label: 'Database đang lỗi',
      value: 'Lỗi',
      note: 'API vẫn trả health nhưng DB không kết nối được. Cần kiểm tra container/log VPS.',
      severity: 'critical',
    });
  }

  if (hasPublicCheckFailure) {
    items.push({
      label: 'Public site cần kiểm tra',
      value: publicChecks.filter((check: any) => check.status !== 'ok').length,
      note: 'Một hoặc nhiều public smoke check đang lỗi.',
      severity: 'critical',
    });
  }

  if (needsBrowser) {
    items.push({
      label: 'Cloudflare/VOZ cần browser',
      value: 1,
      note: 'Cần mở Chromium trên VPS để vượt antibot rồi tải lại số liệu.',
      severity: 'critical',
    });
  }

  items.push(
    {
      label: 'Bài tóm tắt lỗi',
      value: health?.articles?.failed,
      note: `${numberText(health?.articles?.retryable_failed)} bài có thể thử lại.`,
      severity: 'critical',
      target: 'queue:failed',
      runAction: 'summarize',
      actionLabel: 'Chạy tóm tắt',
    },
    {
      label: 'URL lấy bài lỗi',
      value: health?.articleFetchJobs?.failed,
      note: `${numberText(health?.articleFetchJobs?.retryable_failed)} URL có thể thử lại.`,
      severity: 'critical',
      target: 'fetch:failed',
      runAction: 'fetch-articles',
      actionLabel: 'Chạy fetch',
    },
    {
      label: 'Nguồn đang lỗi',
      value: health?.sources?.failing,
      note: `${numberText(health?.sources?.backed_off)} nguồn đang chờ thử lại.`,
      severity: 'critical',
      target: 'sources',
      runAction: 'scrape',
      actionLabel: 'Cào nguồn',
    },
    {
      label: 'Bài chờ tóm tắt',
      value: health?.articles?.pending,
      note: 'Queue AI còn bài chưa xử lý.',
      severity: 'warning',
      target: 'queue:pending',
      runAction: 'summarize',
      actionLabel: 'Chạy tóm tắt',
    },
    {
      label: 'URL chưa lấy bài',
      value: health?.articleFetchJobs?.discovered,
      note: 'URL đã phát hiện nhưng chưa lấy nội dung.',
      severity: 'warning',
      target: 'fetch:discovered',
      runAction: 'fetch-articles',
      actionLabel: 'Chạy fetch',
    },
    {
      label: 'Nguồn lâu chưa ổn',
      value: asCount(health?.sourceQualitySummary?.stale) + asCount(health?.sourceQualitySummary?.low_yield),
      note: `${numberText(health?.sourceQualitySummary?.stale)} stale · ${numberText(health?.sourceQualitySummary?.low_yield)} ít bài mới.`,
      severity: 'warning',
      target: 'sources',
    },
    {
      label: 'Chưa có bản tin',
      value: health?.lastDigest ? 0 : 1,
      note: 'Chưa tìm thấy bản tin gần nhất.',
      severity: 'warning',
      runAction: 'digest',
      actionLabel: 'Tạo bản tin',
    },
    {
      label: 'Bài bị bỏ qua',
      value: health?.articles?.skipped,
      note: 'Thường do nội dung quá ngắn hoặc AI từ chối.',
      severity: 'info',
      target: 'queue:skipped',
    }
  );

  return sortAdminWorkItems(items);
}

export function statusLabel(value: string): string {
  const labels: Record<string, string> = {
    success: 'Thành công',
    partial: 'Một phần',
    failed: 'Lỗi',
    pending: 'Đang chờ',
    discovered: 'Chờ lấy bài',
    fetching: 'Đang lấy bài',
    done: 'Đã xong',
    skipped: 'Bỏ qua',
    processing: 'Đang xử lý',
  };
  return labels[value] || value;
}

export function forumKindLabel(kind: string): string {
  const labels: Record<string, string> = {
    reddit: 'Reddit',
    voz: 'VOZ',
  };
  return labels[kind] || kind;
}

export function forumStatsValue(row: any, key: string): number {
  return Number(row?.[key] || row?.forum?.[key] || 0);
}

export function sourceQualityLabel(status: string): string {
  const labels: Record<string, string> = {
    healthy: 'Ổn',
    low_yield: 'Ít bài mới',
    failing: 'Đang lỗi',
    stale: 'Lâu chưa thành công',
    disabled: 'Đã tắt',
  };
  return labels[status] || status;
}

export function sourceQualityBadgeClass(status: string): string {
  if (status === 'healthy') return 'success';
  if (status === 'disabled') return 'pending';
  if (status === 'low_yield' || status === 'stale') return 'pending';
  return 'error';
}

export function sourceQualityNote(source: any): string {
  if (source.status === 'disabled') return 'Nguồn đang tắt, không cào tự động.';
  if (source.status === 'failing') return source.lastErrorMessage || `${source.consecutiveFailures || 0} lần lỗi liên tiếp.`;
  if (source.status === 'stale') return 'Nguồn bật nhưng lâu chưa có lần cào thành công.';
  if (source.status === 'low_yield') return 'Có cào và tìm thấy bài nhưng gần đây không thêm được bài mới.';
  return 'Nguồn đang hoạt động bình thường.';
}

export function percentText(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return `${Math.round(value * 100)}%`;
}

export function splitLines(value: string): string[] {
  return value
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function joinLines(value: unknown): string {
  return Array.isArray(value) ? value.join('\n') : '';
}

export function buildPromptConfigPayload(formData: PromptConfigFormData) {
  return {
    output_language: formData.output_language.trim(),
    topic_priorities: splitLines(formData.topic_priorities),
    allowed_tags: splitLines(formData.allowed_tags),
    digest_headings: splitLines(formData.digest_headings),
    custom_context: formData.custom_context.trim(),
  };
}

export function getPromptConfigWarnings(formData: PromptConfigFormData): string[] {
  const payload = buildPromptConfigPayload(formData);
  const warnings: string[] = [];
  if (!payload.output_language) warnings.push('Ngôn ngữ output đang trống.');
  if (payload.allowed_tags.length === 0) warnings.push('Danh sách nhãn cần ít nhất 1 nhãn để AI trả kết quả hợp lệ.');
  if (payload.allowed_tags.length > 24) warnings.push('Danh sách nhãn quá nhiều có thể làm AI chọn nhãn thiếu nhất quán.');
  if (payload.topic_priorities.length === 0) warnings.push('Chủ đề ưu tiên đang trống, điểm nóng sẽ ít định hướng hơn.');
  if (payload.digest_headings.length === 0) warnings.push('Nhóm bản tin đang trống, bản tin sẽ khó gom nhóm ổn định.');
  if (payload.custom_context.length > 1500) warnings.push('Ngữ cảnh bổ sung dài hơn 1500 ký tự có thể tốn token và kém ổn định.');
  if (/[<>]/.test(payload.custom_context)) warnings.push('Ngữ cảnh bổ sung không được chứa dấu < hoặc >.');
  return warnings;
}

export function getArticleQualityIssues(article: any): string[] {
  const issues: string[] = [];
  if (!String(article.tldr || '').trim()) issues.push('Thiếu TL;DR');
  if (!String(article.summary_short || '').trim()) issues.push('Thiếu tóm tắt ngắn');
  if (!Array.isArray(article.tags) || article.tags.length === 0) issues.push('Thiếu nhãn');
  if (article.hot_score === null || article.hot_score === undefined) issues.push('Thiếu điểm nóng');
  if (String(article.summary_text || '').trim().length < 200) issues.push('Tóm tắt quá ngắn');
  return issues;
}


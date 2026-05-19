import { query, getOne } from '../db/index.js';

interface AiProvider {
  id: string;
  name: string;
  provider_type: string;
  api_endpoint: string | null;
  api_key: string | null;
  model: string;
  project_id: string | null;
  region: string | null;
  service_account_json: string | null;
  max_tokens: number;
  temperature: number;
  extra_config: any;
}

interface AiCallOptions {
  max_tokens?: number;
  temperature?: number;
  timeoutMs?: number;
}

interface AiRoutingSettings {
  primary_provider_id?: string | null;
  fallback_provider_id?: string | null;
}

function appendApiKey(url: string, apiKey: string): string {
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}key=${encodeURIComponent(apiKey)}`;
}

// Modern Gemini "thinking" models (2.5+, 3.x) consume budget on thoughtsTokenCount BEFORE
// emitting any output. With a small maxOutputTokens the response gets truncated to 0 parts and
// finishReason=MAX_TOKENS. Use a generous floor so small DB defaults like 4096 do not silently fail.
const GEMINI_MIN_OUTPUT_TOKENS = 16384;

function resolveGeminiMaxTokens(providerMaxTokens: number): number {
  const base = Number.isFinite(providerMaxTokens) && providerMaxTokens > 0 ? providerMaxTokens : 0;
  return Math.max(base, GEMINI_MIN_OUTPUT_TOKENS);
}

// Build the optional `thinkingConfig` block for Gemini generationConfig.
// Provider can opt out of thinking entirely (thinkingBudget=0) or cap it via
// `extra_config.thinking_budget` in the DB. Returns undefined when the provider
// hasn't configured anything, so we keep the model's default behavior.
function resolveGeminiThinkingConfig(provider: AiProvider): { thinkingBudget: number } | undefined {
  const raw = provider.extra_config?.thinking_budget;
  if (raw === undefined || raw === null) return undefined;
  const n = typeof raw === 'number' ? raw : parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return { thinkingBudget: n };
}

function buildGeminiGenerationConfig(provider: AiProvider) {
  const cfg: any = {
    temperature: provider.temperature,
    maxOutputTokens: resolveGeminiMaxTokens(provider.max_tokens),
  };
  const thinking = resolveGeminiThinkingConfig(provider);
  if (thinking) cfg.thinkingConfig = thinking;
  return cfg;
}

function extractGeminiText(data: any): string {
  const candidate = data?.candidates?.[0];
  const parts = candidate?.content?.parts;
  const finishReason = candidate?.finishReason;
  const text = Array.isArray(parts)
    ? parts.map((p: any) => (typeof p?.text === 'string' ? p.text : '')).join('')
    : '';

  if (!text) {
    if (finishReason === 'MAX_TOKENS') {
      const usage = data?.usageMetadata || {};
      throw new Error(
        `Gemini truncated to empty output (finishReason=MAX_TOKENS, thoughtsTokenCount=${usage.thoughtsTokenCount ?? '?'}, candidatesTokenCount=${usage.candidatesTokenCount ?? '?'}). Increase max_tokens for thinking models.`
      );
    }
    if (finishReason && finishReason !== 'STOP') {
      throw new Error(`Gemini returned no text (finishReason=${finishReason}).`);
    }
  }
  return text;
}

function resolveOpenAiCompatibleEndpoint(rawEndpoint: string | null | undefined, fallback = ''): string {
  const endpoint = (rawEndpoint || fallback || '').trim();
  if (!endpoint) return '';

  if (endpoint.endsWith('/chat/completions')) {
    return endpoint;
  }

  const normalized = endpoint.replace(/\/+$/, '');
  if (normalized.endsWith('/v1')) {
    return `${normalized}/chat/completions`;
  }

  return `${normalized}/v1/chat/completions`;
}

/**
 * Parse an OpenAI-compatible response that may come back as either
 * a normal JSON body or an SSE (text/event-stream) body.
 */
async function parseOpenAiResponse(response: Response): Promise<string> {
  const ct = response.headers.get('content-type') || '';

  // Normal JSON response
  if (ct.includes('application/json')) {
    const data = await response.json();
    return data.choices?.[0]?.message?.content || '';
  }

  // SSE / streaming response — collect all delta chunks
  const text = await response.text();
  const parts: string[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data: ')) continue;
    const payload = trimmed.slice(6);
    if (payload === '[DONE]') break;
    try {
      const chunk = JSON.parse(payload);
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) parts.push(delta);
    } catch {
      // skip unparseable lines
    }
  }
  if (parts.length > 0) return parts.join('');

  // Last resort — try parsing entire body as JSON anyway
  try {
    const data = JSON.parse(text);
    return data.choices?.[0]?.message?.content || '';
  } catch {
    throw new Error(`Unexpected AI response format (content-type: ${ct}): ${text.substring(0, 200)}`);
  }
}

// ==========================================
// Lay active provider tu DB
// ==========================================
export async function getActiveProvider(): Promise<AiProvider | null> {
  return getOne<AiProvider>(
    'SELECT * FROM ai_providers WHERE is_active = true LIMIT 1'
  );
}

async function getProviderById(id: string | null | undefined): Promise<AiProvider | null> {
  if (!id) return null;
  return getOne<AiProvider>('SELECT * FROM ai_providers WHERE id = $1', [id]);
}

async function getAiRoutingSettings(): Promise<AiRoutingSettings> {
  const row = await getOne<{ value_json: string }>(
    'SELECT value_json FROM app_settings WHERE key = $1',
    ['ai_provider_routing']
  );
  if (!row?.value_json) return {};

  try {
    return JSON.parse(row.value_json) || {};
  } catch {
    return {};
  }
}

function isRetryableAiError(err: any): boolean {
  const message = String(err?.message || err || '').toLowerCase();
  if (/\b(429|408|500|502|503|504)\b/.test(message)) return true;
  return message.includes('rate limit') ||
    message.includes('too many requests') ||
    message.includes('timeout') ||
    message.includes('timed out') ||
    message.includes('econnreset') ||
    message.includes('etimedout') ||
    message.includes('socket hang up');
}

// ==========================================
// Goi AI - dung provider chinh, fallback khi loi tam thoi
// ==========================================
export async function callAi(prompt: string, overrides?: AiCallOptions): Promise<string> {
  const routing = await getAiRoutingSettings();
  const primaryProvider = await getProviderById(routing.primary_provider_id) || await getActiveProvider();
  if (!primaryProvider) {
    throw new Error('No active AI provider configured. Go to Settings > AI Providers to set one up.');
  }

  try {
    return await callAiProvider(primaryProvider, prompt, overrides);
  } catch (err: any) {
    const fallbackProvider = await getProviderById(routing.fallback_provider_id);
    if (!fallbackProvider || fallbackProvider.id === primaryProvider.id || !isRetryableAiError(err)) {
      throw err;
    }

    console.warn(`AI primary provider failed, falling back from ${primaryProvider.name} to ${fallbackProvider.name}: ${err.message}`);
    return callAiProvider(fallbackProvider, prompt, overrides);
  }
}

// ==========================================
// Goi AI voi 1 provider cu the
// ==========================================
export async function callAiProvider(provider: AiProvider, prompt: string, overrides?: AiCallOptions): Promise<string> {
  try {
    let result: string;

    const timeoutMs = overrides?.timeoutMs ?? parseInt(process.env.AI_REQUEST_TIMEOUT_MS || '60000', 10);
    const finalProvider = {
      ...provider,
      max_tokens: overrides?.max_tokens ?? provider.max_tokens,
      temperature: overrides?.temperature ?? provider.temperature
    };

    switch (finalProvider.provider_type) {
      case 'vertex_ai_key':
        result = await callVertexAiKey(finalProvider, prompt, timeoutMs);
        break;
      case 'gemini':
        result = await callGeminiStudio(finalProvider, prompt, timeoutMs);
        break;
      case 'openai':
      case 'openai_responses':
      case 'xai':
      case 'deepseek':
      case 'groq':
      case 'mimo':
        result = await callOpenAiCompatible(finalProvider, prompt, timeoutMs);
        break;
      case 'anthropic':
        result = await callAnthropic(finalProvider, prompt, timeoutMs);
        break;
      case 'custom':
        result = await callCustom(finalProvider, prompt, timeoutMs);
        break;
      default:
        throw new Error(`Unsupported provider type: ${finalProvider.provider_type}`);
    }

    // Safety check: if the router or API intercepted and returned the raw rejection string
    if (result.includes('The request was rejected because it was considered high risk')) {
      throw new Error('AI Provider rejected the request due to safety/high-risk filters.');
    }

    // Update tracking
    await query(
      `UPDATE ai_providers SET total_calls = total_calls + 1, last_used_at = NOW(), last_error_message = NULL WHERE id = $1`,
      [provider.id]
    );

    return result;
  } catch (err: any) {
    // Update error tracking
    await query(
      `UPDATE ai_providers SET total_errors = total_errors + 1, last_error_message = $1 WHERE id = $2`,
      [err.message.substring(0, 500), provider.id]
    );
    throw err;
  }
}

// ==========================================
// VERTEX AI (Google Cloud)
// ==========================================
async function callVertexAiKey(provider: AiProvider, prompt: string, timeoutMs: number): Promise<string> {
  if (!provider.api_key) throw new Error('Vertex AI API key requires api_key');

  const baseUrl = provider.api_endpoint ||
    `https://aiplatform.googleapis.com/v1/publishers/google/models/${provider.model}:generateContent`;

  const response = await fetch(appendApiKey(baseUrl, provider.api_key), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: buildGeminiGenerationConfig(provider),
      safetySettings: [
        { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
      ]
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Vertex AI API key ${response.status}: ${errText.substring(0, 300)}`);
  }

  const data = await response.json();
  return extractGeminiText(data);
}

// ==========================================
// GEMINI AI STUDIO (Google)
// ==========================================
async function callGeminiStudio(provider: AiProvider, prompt: string, timeoutMs: number): Promise<string> {
  if (!provider.api_key) throw new Error('Gemini AI Studio requires api_key');

  const url = provider.api_endpoint ||
    `https://generativelanguage.googleapis.com/v1/models/${provider.model}:generateContent`;

  const response = await fetch(appendApiKey(url, provider.api_key), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: buildGeminiGenerationConfig(provider),
      safetySettings: [
        { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
      ]
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini ${response.status}: ${errText.substring(0, 300)}`);
  }

  const data = await response.json();
  return extractGeminiText(data);
}

// ==========================================
// OPENAI-COMPATIBLE (OpenAI, xAI/Grok, DeepSeek, Groq, Mimo, ...)
// ==========================================
async function callOpenAiCompatible(provider: AiProvider, prompt: string, timeoutMs: number): Promise<string> {
  if (!provider.api_key) throw new Error(`${provider.name} requires api_key`);

  if (provider.provider_type === 'openai_responses') {
    return callOpenAiResponses(provider, prompt, timeoutMs);
  }

  // Default endpoints theo provider_type
  const defaultEndpoints: Record<string, string> = {
    openai: 'https://api.openai.com/v1/chat/completions',
    xai: 'https://api.x.ai/v1/chat/completions',
    deepseek: 'https://api.deepseek.com/v1/chat/completions',
    groq: 'https://api.groq.com/openai/v1/chat/completions',
    mimo: 'https://token-plan-sgp.xiaomimimo.com/v1/chat/completions',
  };

  const url = resolveOpenAiCompatibleEndpoint(provider.api_endpoint, defaultEndpoints[provider.provider_type] || '');
  if (!url) throw new Error(`No endpoint configured for ${provider.provider_type}`);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${provider.api_key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: provider.model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: provider.max_tokens,
      temperature: provider.temperature,
      stream: false,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`${provider.name} ${response.status}: ${errText.substring(0, 300)}`);
  }

  return parseOpenAiResponse(response);
}

async function callOpenAiResponses(provider: AiProvider, prompt: string, timeoutMs: number): Promise<string> {
  const endpoint = (provider.api_endpoint || 'https://api.openai.com/v1/responses').trim().replace(/\/+$/, '');
  const url = endpoint.endsWith('/responses') ? endpoint : `${endpoint}/responses`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${provider.api_key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: provider.model,
      input: prompt,
      max_output_tokens: provider.max_tokens,
      temperature: provider.temperature,
      stream: false,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`${provider.name} ${response.status}: ${errText.substring(0, 300)}`);
  }

  const data = await response.json();
  if (typeof data.output_text === 'string') return data.output_text;
  const text = data.output?.flatMap((item: any) => item.content || [])
    .map((content: any) => content.text || '')
    .filter(Boolean)
    .join('');
  return text || '';
}

// ==========================================
// ANTHROPIC (Claude)
// ==========================================
async function callAnthropic(provider: AiProvider, prompt: string, timeoutMs: number): Promise<string> {
  if (!provider.api_key) throw new Error('Anthropic requires api_key');

  const url = provider.api_endpoint || 'https://api.anthropic.com/v1/messages';

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'x-api-key': provider.api_key,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: provider.model,
      max_tokens: provider.max_tokens,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Anthropic ${response.status}: ${errText.substring(0, 300)}`);
  }

  const data = await response.json();
  return data.content?.[0]?.text || '';
}

// ==========================================
// CUSTOM - OpenAI-compatible format
// ==========================================
async function callCustom(provider: AiProvider, prompt: string, timeoutMs: number): Promise<string> {
  const format = provider.extra_config?.format || 'openai'; // 'openai' | 'gemini'
  const url = format === 'openai'
    ? resolveOpenAiCompatibleEndpoint(provider.api_endpoint)
    : (provider.api_endpoint || '').trim();

  if (!url) throw new Error('Custom provider requires api_endpoint');

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (provider.api_key) {
    headers['Authorization'] = `Bearer ${provider.api_key}`;
  }

  let body: any;
  if (format === 'gemini') {
    body = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: buildGeminiGenerationConfig(provider),
      safetySettings: [
        { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
      ]
    };
  } else {
    body = {
      model: provider.model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: provider.max_tokens,
      temperature: provider.temperature,
      stream: false,
    };
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Custom AI ${response.status}: ${errText.substring(0, 300)}`);
  }

  if (format === 'gemini') {
    const data = await response.json();
    return extractGeminiText(data);
  }
  return parseOpenAiResponse(response);
}

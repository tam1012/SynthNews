export const AI_PROVIDER_TYPES = [
  'vertex_ai_key',
  'openai',
  'openai_responses',
  'gemini',
  'xai',
  'mimo',
  'anthropic',
  'deepseek',
  'groq',
  'custom',
  'cliproxyapi',
] as const;

export type AiProviderType = typeof AI_PROVIDER_TYPES[number];

export type AiProviderCreatePayload = {
  name: string;
  provider_type: AiProviderType;
  model: string;
  api_endpoint: string | null;
  api_key: string | null;
  max_tokens: number;
  temperature: number;
  extra_config: Record<string, unknown> | null;
};

export type AiProviderPatchPayload = Partial<AiProviderCreatePayload>;

export type AiProviderRoutingPayload = {
  primary_provider_id: string | null;
  fallback_provider_id: string | null;
};

const CREATE_FIELDS = new Set([
  'name',
  'provider_type',
  'model',
  'api_endpoint',
  'api_key',
  'max_tokens',
  'temperature',
  'extra_config',
]);

const PATCH_FIELDS = new Set(CREATE_FIELDS);
const ROUTING_FIELDS = new Set(['primary_provider_id', 'fallback_provider_id']);

function assertPlainObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertAllowedFields(value: Record<string, unknown>, allowed: Set<string>) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`Unexpected field: ${key}`);
  }
}

function stringField(value: unknown, label: string, maxLength: number, required = true): string | null {
  if (value === undefined || value === null) {
    if (required) throw new Error(`${label} is required`);
    return null;
  }
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) {
    if (required) throw new Error(`${label} is required`);
    return null;
  }
  if (trimmed.length > maxLength) throw new Error(`${label} is too long`);
  return trimmed;
}

function providerTypeField(value: unknown): AiProviderType {
  const providerType = stringField(value, 'provider_type', 80);
  if (!providerType || !AI_PROVIDER_TYPES.includes(providerType as AiProviderType)) {
    throw new Error(`provider_type must be one of: ${AI_PROVIDER_TYPES.join(', ')}`);
  }
  return providerType as AiProviderType;
}

function nullableHttpUrlField(value: unknown, label: string): string | null {
  const trimmed = stringField(value, label, 2048, false);
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`${label} must be a valid http(s) URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${label} must be a valid http(s) URL`);
  }
  return trimmed;
}

function numberField(value: unknown, label: string, fallback: number, min: number, max: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const numberValue = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numberValue)) throw new Error(`${label} must be a number`);
  if (numberValue < min || numberValue > max) throw new Error(`${label} must be between ${min} and ${max}`);
  return label === 'max_tokens' ? Math.floor(numberValue) : numberValue;
}

function nullableSecretField(value: unknown, label: string): string | null {
  return stringField(value, label, 50000, false);
}

function extraConfigField(value: unknown): Record<string, unknown> | null {
  if (value === undefined || value === null || value === '') return null;
  const config = assertPlainObject(value, 'extra_config');
  const serialized = JSON.stringify(config);
  if (serialized.length > 20000) throw new Error('extra_config is too large');
  return config;
}

function providerIdField(value: unknown, label: string): string | null {
  const id = stringField(value, label, 200, false);
  return id || null;
}

function commonCreateFields(raw: Record<string, unknown>): AiProviderCreatePayload {
  return {
    name: stringField(raw.name, 'name', 160) as string,
    provider_type: providerTypeField(raw.provider_type),
    model: stringField(raw.model, 'model', 240) as string,
    api_endpoint: nullableHttpUrlField(raw.api_endpoint, 'api_endpoint'),
    api_key: nullableSecretField(raw.api_key, 'api_key'),
    max_tokens: numberField(raw.max_tokens, 'max_tokens', 4096, 1, 65536),
    temperature: numberField(raw.temperature, 'temperature', 0.3, 0, 2),
    extra_config: extraConfigField(raw.extra_config),
  };
}

export function validateAiProviderCreatePayload(value: unknown): AiProviderCreatePayload {
  const raw = assertPlainObject(value, 'AI provider payload');
  assertAllowedFields(raw, CREATE_FIELDS);
  return commonCreateFields(raw);
}

export function validateAiProviderPatchPayload(value: unknown): AiProviderPatchPayload {
  const raw = assertPlainObject(value, 'AI provider payload');
  assertAllowedFields(raw, PATCH_FIELDS);

  const patch: AiProviderPatchPayload = {};
  if (raw.name !== undefined) patch.name = stringField(raw.name, 'name', 160) as string;
  if (raw.provider_type !== undefined) patch.provider_type = providerTypeField(raw.provider_type);
  if (raw.model !== undefined) patch.model = stringField(raw.model, 'model', 240) as string;
  if (raw.api_endpoint !== undefined) patch.api_endpoint = nullableHttpUrlField(raw.api_endpoint, 'api_endpoint');
  if (raw.api_key !== undefined) patch.api_key = nullableSecretField(raw.api_key, 'api_key');
  if (raw.max_tokens !== undefined) patch.max_tokens = numberField(raw.max_tokens, 'max_tokens', 4096, 1, 65536);
  if (raw.temperature !== undefined) patch.temperature = numberField(raw.temperature, 'temperature', 0.3, 0, 2);
  if (raw.extra_config !== undefined) patch.extra_config = extraConfigField(raw.extra_config);

  if (Object.keys(patch).length === 0) throw new Error('No fields to update');
  return patch;
}

export function validateAiProviderRoutingPayload(value: unknown): AiProviderRoutingPayload {
  const raw = assertPlainObject(value, 'AI provider routing payload');
  assertAllowedFields(raw, ROUTING_FIELDS);
  return {
    primary_provider_id: providerIdField(raw.primary_provider_id, 'primary_provider_id'),
    fallback_provider_id: providerIdField(raw.fallback_provider_id, 'fallback_provider_id'),
  };
}

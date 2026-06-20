import { Hono } from 'hono';
import { getMany, getOne, query, withTransaction } from '../db/index.js';
import { generateId } from '../lib/utils.js';
import {
  validateAiProviderCreatePayload,
  validateAiProviderPatchPayload,
  validateAiProviderRoutingPayload,
} from '../lib/aiProviderValidation.js';

const aiProviders = new Hono();

const AI_ROUTING_SETTING_KEY = 'ai_provider_routing';

async function getAiRoutingSettings() {
  const row = await getOne<{ value_json: string }>(
    'SELECT value_json FROM app_settings WHERE key = $1',
    [AI_ROUTING_SETTING_KEY]
  );
  if (!row?.value_json) return { primary_provider_id: null, fallback_provider_id: null };

  try {
    const parsed = JSON.parse(row.value_json) || {};
    return {
      primary_provider_id: parsed.primary_provider_id || null,
      fallback_provider_id: parsed.fallback_provider_id || null,
    };
  } catch {
    return { primary_provider_id: null, fallback_provider_id: null };
  }
}

async function providerExists(id: string | null | undefined): Promise<boolean> {
  if (!id) return true;
  const row = await getOne('SELECT id FROM ai_providers WHERE id = $1', [id]);
  return Boolean(row);
}

async function readJsonBody(c: any): Promise<unknown> {
  return c.req.json().catch(() => ({}));
}

function validationResponse(c: any, err: unknown) {
  return c.json({
    success: false,
    error: {
      code: 'VALIDATION',
      message: err instanceof Error ? err.message : 'Invalid request payload',
    },
  }, 400);
}

// Danh sach providers
aiProviders.get('/', async (c) => {
  const rows = await getMany(
    `SELECT id, name, provider_type, is_active, api_endpoint, model,
            project_id, region, max_tokens, temperature,
            total_calls, total_errors, last_used_at, last_error_message,
            extra_config, created_at, updated_at
     FROM ai_providers ORDER BY is_active DESC, created_at DESC`
  );
  // KHONG tra ve api_key va service_account_json trong list
  return c.json({ success: true, data: rows });
});

aiProviders.get('/routing', async (c) => {
  const routing = await getAiRoutingSettings();
  return c.json({ success: true, data: routing });
});

aiProviders.patch('/routing', async (c) => {
  let routing;
  try {
    routing = validateAiProviderRoutingPayload(await readJsonBody(c));
  } catch (err) {
    return validationResponse(c, err);
  }
  const { primary_provider_id: primaryProviderId, fallback_provider_id: fallbackProviderId } = routing;

  if (!await providerExists(primaryProviderId) || !await providerExists(fallbackProviderId)) {
    return c.json({ success: false, error: { code: 'VALIDATION', message: 'Provider not found' } }, 400);
  }

  const value = JSON.stringify({
    primary_provider_id: primaryProviderId,
    fallback_provider_id: fallbackProviderId,
  });

  await query(
    `INSERT INTO app_settings (key, value_json, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value_json = EXCLUDED.value_json, updated_at = NOW()`,
    [AI_ROUTING_SETTING_KEY, value]
  );

  if (primaryProviderId) {
    await withTransaction(async (client) => {
      await client.query('UPDATE ai_providers SET is_active = false');
      await client.query('UPDATE ai_providers SET is_active = true WHERE id = $1', [primaryProviderId]);
    });
  }

  return c.json({ success: true, data: JSON.parse(value) });
});

async function fetchModelsFromEndpoint(apiEndpoint: string, apiKey: string): Promise<{ id: string }[]> {
  const base = apiEndpoint.replace(/\/+$/, '');
  const modelsUrl = base.endsWith('/v1') ? `${base}/models` : `${base}/v1/models`;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const response = await fetch(modelsUrl, {
    headers,
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`${response.status}: ${errText.substring(0, 200)}`);
  }

  const data = await response.json();
  const models = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
  return models.map((m: any) => ({ id: typeof m === 'string' ? m : m.id || m.name || '' })).filter((m: any) => m.id);
}

// Lay danh sach model tu endpoint bat ky (dung khi tao provider moi)
aiProviders.post('/fetch-models', async (c) => {
  const body = await readJsonBody(c) as any;
  const endpoint = (body?.api_endpoint || '').trim();
  const apiKey = (body?.api_key || '').trim();

  if (!endpoint) {
    return c.json({ success: false, error: { code: 'VALIDATION', message: 'api_endpoint is required' } }, 400);
  }

  try {
    const models = await fetchModelsFromEndpoint(endpoint, apiKey);
    return c.json({ success: true, data: models });
  } catch (err: any) {
    return c.json({ success: false, error: { code: 'FETCH_MODELS_FAILED', message: err.message } }, 500);
  }
});

// Chi tiet 1 provider (van mask sensitive fields)
aiProviders.get('/:id', async (c) => {
  const { id } = c.req.param();
  const row = await getOne(
    `SELECT id, name, provider_type, is_active, api_endpoint, model,
            project_id, region, max_tokens, temperature,
            total_calls, total_errors, last_used_at, last_error_message,
            extra_config, created_at, updated_at,
            CASE WHEN api_key IS NOT NULL AND api_key != '' THEN true ELSE false END as has_api_key
     FROM ai_providers WHERE id = $1`,
    [id]
  );
  if (!row) {
    return c.json({ success: false, error: { code: 'NOT_FOUND', message: 'Provider not found' } }, 404);
  }
  return c.json({ success: true, data: row });
});

// Them provider moi
aiProviders.post('/', async (c) => {
  let payload;
  try {
    payload = validateAiProviderCreatePayload(await readJsonBody(c));
  } catch (err) {
    return validationResponse(c, err);
  }

  const id = generateId('aip');

  await query(
    `INSERT INTO ai_providers (id, name, provider_type, model, api_endpoint, api_key,
                                max_tokens, temperature, extra_config)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      id, payload.name, payload.provider_type, payload.model, payload.api_endpoint, payload.api_key,
      payload.max_tokens, payload.temperature,
      payload.extra_config ? JSON.stringify(payload.extra_config) : null,
    ]
  );

  const row = await getOne(
    `SELECT id, name, provider_type, is_active, api_endpoint, model,
            project_id, region, max_tokens, temperature, created_at
     FROM ai_providers WHERE id = $1`,
    [id]
  );
  return c.json({ success: true, data: row }, 201);
});

// Cap nhat provider
aiProviders.patch('/:id', async (c) => {
  const { id } = c.req.param();
  let payload;
  try {
    payload = validateAiProviderPatchPayload(await readJsonBody(c));
  } catch (err) {
    return validationResponse(c, err);
  }

  const existing = await getOne('SELECT id FROM ai_providers WHERE id = $1', [id]);
  if (!existing) {
    return c.json({ success: false, error: { code: 'NOT_FOUND', message: 'Provider not found' } }, 404);
  }

  const updates: string[] = [];
  const values: any[] = [];
  let paramIndex = 1;

  for (const [field, rawValue] of Object.entries(payload)) {
    const value = field === 'extra_config' && rawValue
      ? JSON.stringify(rawValue)
      : rawValue;
    updates.push(`${field} = $${paramIndex}`);
    values.push(value);
    paramIndex++;
  }

  values.push(id);
  await query(`UPDATE ai_providers SET ${updates.join(', ')} WHERE id = $${paramIndex}`, values);

  const row = await getOne(
    `SELECT id, name, provider_type, is_active, api_endpoint, model,
            project_id, region, max_tokens, temperature,
            total_calls, total_errors, last_used_at, extra_config,
            CASE WHEN api_key IS NOT NULL AND api_key != '' THEN true ELSE false END as has_api_key,
            created_at, updated_at
     FROM ai_providers WHERE id = $1`,
    [id]
  );
  return c.json({ success: true, data: row });
});

// Xoa provider
aiProviders.delete('/:id', async (c) => {
  const { id } = c.req.param();
  const result = await query('DELETE FROM ai_providers WHERE id = $1', [id]);
  if (result.rowCount === 0) {
    return c.json({ success: false, error: { code: 'NOT_FOUND', message: 'Provider not found' } }, 404);
  }
  return c.json({ success: true, data: { deleted: true } });
});

// Set provider lam active (tat cac provider khac)
aiProviders.post('/:id/activate', async (c) => {
  const { id } = c.req.param();

  const existing = await getOne('SELECT id FROM ai_providers WHERE id = $1', [id]);
  if (!existing) {
    return c.json({ success: false, error: { code: 'NOT_FOUND', message: 'Provider not found' } }, 404);
  }

  // Tat tat ca provider khac
  await withTransaction(async (client) => {
    await client.query('UPDATE ai_providers SET is_active = false');
    await client.query('UPDATE ai_providers SET is_active = true WHERE id = $1', [id]);
  });
  // Bat provider nay
  const routing = await getAiRoutingSettings();
  await query(
    `INSERT INTO app_settings (key, value_json, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value_json = EXCLUDED.value_json, updated_at = NOW()`,
    [AI_ROUTING_SETTING_KEY, JSON.stringify({ ...routing, primary_provider_id: id })]
  );

  return c.json({ success: true, data: { activated: true } });
});

// Test provider (goi thu 1 request)
aiProviders.post('/:id/test', async (c) => {
  const { id } = c.req.param();
  const provider = await getOne('SELECT * FROM ai_providers WHERE id = $1', [id]);
  if (!provider) {
    return c.json({ success: false, error: { code: 'NOT_FOUND', message: 'Provider not found' } }, 404);
  }

  try {
    // Import dynamically de tranh circular dependency
    const { callAiProvider } = await import('../services/ai-client.js');
    const startTime = Date.now();
    const result = await callAiProvider(provider, 'Xin chào, hãy trả lời "OK" bằng 1 từ duy nhất.');
    const duration = Date.now() - startTime;

    return c.json({
      success: true,
      data: {
        response: result.substring(0, 200),
        duration_ms: duration,
        provider: provider.name,
        model: provider.model,
      },
    });
  } catch (err: any) {
    return c.json({
      success: false,
      error: { code: 'AI_TEST_FAILED', message: err.message },
    }, 500);
  }
});

// Lay danh sach model tu provider da luu
aiProviders.get('/:id/models', async (c) => {
  const { id } = c.req.param();
  const provider = await getOne<{ api_endpoint: string; api_key: string }>('SELECT api_endpoint, api_key FROM ai_providers WHERE id = $1', [id]);
  if (!provider) {
    return c.json({ success: false, error: { code: 'NOT_FOUND', message: 'Provider not found' } }, 404);
  }
  if (!provider.api_endpoint) {
    return c.json({ success: false, error: { code: 'VALIDATION', message: 'Provider has no endpoint configured' } }, 400);
  }

  try {
    const models = await fetchModelsFromEndpoint(provider.api_endpoint, provider.api_key || '');
    return c.json({ success: true, data: models });
  } catch (err: any) {
    return c.json({ success: false, error: { code: 'FETCH_MODELS_FAILED', message: err.message } }, 500);
  }
});

export { aiProviders };

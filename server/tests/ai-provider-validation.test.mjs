import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadValidationModule() {
  const path = resolve(__dirname, '../src/lib/aiProviderValidation.ts');
  if (!existsSync(path)) {
    assert.fail('server/src/lib/aiProviderValidation.ts should define AI provider route validation');
  }
  const source = readFileSync(path, 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const moduleContext = { exports: {} };
  vm.runInNewContext(outputText, {
    exports: moduleContext.exports,
    module: moduleContext,
    URL,
  });
  return moduleContext.exports;
}

function jsonValue(value) {
  return JSON.parse(JSON.stringify(value));
}

test('AI provider routes delegate unsafe payloads to validation boundary helpers', () => {
  const source = readFileSync(resolve(__dirname, '../src/routes/ai-providers.ts'), 'utf8');

  assert.match(source, /validateAiProviderCreatePayload/);
  assert.match(source, /validateAiProviderPatchPayload/);
  assert.match(source, /validateAiProviderRoutingPayload/);
});

test('AI provider create validation normalizes valid payloads and rejects malformed fields', () => {
  const { validateAiProviderCreatePayload } = loadValidationModule();

  assert.deepEqual(jsonValue(validateAiProviderCreatePayload({
    name: '  Primary model ',
    provider_type: 'custom',
    model: '  gpt-compatible ',
    api_endpoint: 'http://host.docker.internal:20128/v1',
    api_key: '',
    max_tokens: '8192',
    temperature: '0.4',
    extra_config: { format: 'openai' },
  })), {
    name: 'Primary model',
    provider_type: 'custom',
    model: 'gpt-compatible',
    api_endpoint: 'http://host.docker.internal:20128/v1',
    api_key: null,
    max_tokens: 8192,
    temperature: 0.4,
    extra_config: { format: 'openai' },
  });

  assert.throws(() => validateAiProviderCreatePayload({ name: '', provider_type: 'custom', model: 'm' }), /name/);
  assert.throws(() => validateAiProviderCreatePayload({ name: 'x', provider_type: 'bad', model: 'm' }), /provider_type/);
  assert.throws(() => validateAiProviderCreatePayload({ name: 'x', provider_type: 'custom', model: '' }), /model/);
  assert.throws(() => validateAiProviderCreatePayload({ name: 'x', provider_type: 'custom', model: 'm', api_endpoint: 'ftp://example.com' }), /api_endpoint/);
  assert.throws(() => validateAiProviderCreatePayload({ name: 'x', provider_type: 'custom', model: 'm', max_tokens: 0 }), /max_tokens/);
  assert.throws(() => validateAiProviderCreatePayload({ name: 'x', provider_type: 'custom', model: 'm', temperature: 99 }), /temperature/);
  assert.throws(() => validateAiProviderCreatePayload({ name: 'x', provider_type: 'custom', model: 'm', extra_config: [] }), /extra_config/);
  assert.throws(() => validateAiProviderCreatePayload({ name: 'x', provider_type: 'custom', model: 'm', parser_config: {} }), /Unexpected field/);
});

test('AI provider patch and routing validation constrain partial updates', () => {
  const {
    validateAiProviderPatchPayload,
    validateAiProviderRoutingPayload,
  } = loadValidationModule();

  assert.deepEqual(jsonValue(validateAiProviderPatchPayload({
    api_key: '',
    max_tokens: 16384,
    temperature: '0',
  })), {
    api_key: null,
    max_tokens: 16384,
    temperature: 0,
  });

  assert.throws(() => validateAiProviderPatchPayload({}), /No fields/);
  assert.throws(() => validateAiProviderPatchPayload({ max_tokens: 999999 }), /max_tokens/);
  assert.throws(() => validateAiProviderPatchPayload({ extra_config: 'not-json-object' }), /extra_config/);
  assert.throws(() => validateAiProviderPatchPayload({ service_account_json: '{}' }), /Unexpected field/);

  assert.deepEqual(jsonValue(validateAiProviderRoutingPayload({
    primary_provider_id: 'aip_123',
    fallback_provider_id: '',
  })), {
    primary_provider_id: 'aip_123',
    fallback_provider_id: null,
  });
  assert.throws(() => validateAiProviderRoutingPayload({ primary_provider_id: ['aip_1'] }), /primary_provider_id/);
});

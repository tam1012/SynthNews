import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

function loadUtils() {
  const source = readFileSync(resolve(__dirname, '../src/lib/utils.ts'), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const moduleContext = { exports: {} };
  vm.runInNewContext(outputText, {
    URL,
    exports: moduleContext.exports,
    module: moduleContext,
    require: (name) => {
      if (name === 'nanoid') return { nanoid: () => 'test-id' };
      if (name === 'crypto') return require('node:crypto');
      if (name === 'node:dns/promises') return { lookup: async () => ({ address: '93.184.216.34' }) };
      if (name === 'node:net') return require('node:net');
      throw new Error(`Unexpected require ${name}`);
    },
  });
  return moduleContext.exports;
}

test('isBlockedIpAddress blocks private, loopback, metadata, and reserved IP ranges', () => {
  const { isBlockedIpAddress } = loadUtils();

  assert.equal(isBlockedIpAddress('127.0.0.1'), true);
  assert.equal(isBlockedIpAddress('10.2.3.4'), true);
  assert.equal(isBlockedIpAddress('172.16.0.1'), true);
  assert.equal(isBlockedIpAddress('192.168.1.10'), true);
  assert.equal(isBlockedIpAddress('169.254.169.254'), true);
  assert.equal(isBlockedIpAddress('0.0.0.0'), true);
  assert.equal(isBlockedIpAddress('::1'), true);
  assert.equal(isBlockedIpAddress('::'), true);
  assert.equal(isBlockedIpAddress('fc00::1'), true);
  assert.equal(isBlockedIpAddress('fe80::1'), true);
  assert.equal(isBlockedIpAddress('2001:db8::1'), true);

  assert.equal(isBlockedIpAddress('93.184.216.34'), false);
  assert.equal(isBlockedIpAddress('2606:2800:220:1:248:1893:25c8:1946'), false);
});

test('normalizePublicHttpUrlWithDns rejects public-looking hostnames that resolve to private IPs', async () => {
  const { normalizePublicHttpUrlWithDns } = loadUtils();
  const privateDns = async () => [{ address: '127.0.0.1' }];
  const publicDns = async () => [{ address: '93.184.216.34' }];

  assert.equal(
    await normalizePublicHttpUrlWithDns('https://evil.example/path', true, privateDns),
    null,
  );
  assert.equal(
    await normalizePublicHttpUrlWithDns('https://example.com/path', true, publicDns),
    'https://example.com/path',
  );
});

test('normalizePublicHttpUrlWithDns rejects redirects to private network URLs before following them', async () => {
  const { normalizePublicHttpUrlWithDns } = loadUtils();

  assert.equal(
    await normalizePublicHttpUrlWithDns('http://169.254.169.254/latest/meta-data', true, async () => []),
    null,
  );
  assert.equal(
    await normalizePublicHttpUrlWithDns('http://[::1]/health', true, async () => []),
    null,
  );
});

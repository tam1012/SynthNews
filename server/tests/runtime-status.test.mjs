import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadTsModule(relativePath) {
  const source = readFileSync(resolve(__dirname, relativePath), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const moduleContext = { exports: {} };
  vm.runInNewContext(outputText, {
    AbortSignal,
    URL,
    clearTimeout,
    exports: moduleContext.exports,
    module: moduleContext,
    process: { env: {} },
    require: () => ({}),
    setTimeout,
  });
  return moduleContext.exports;
}

test('deploy info normalizes current commit, short commit, branch, and deploy time', () => {
  const { getDeployInfo } = loadTsModule('../src/lib/runtime-status.ts');

  const deploy = getDeployInfo({
    GITHUB_SHA: '38775de123456789',
    GITHUB_REF_NAME: 'main',
    DEPLOYED_AT: '2026-05-29T12:00:00.000Z',
  });

  assert.equal(deploy.commit, '38775de123456789');
  assert.equal(deploy.shortCommit, '38775de');
  assert.equal(deploy.branch, 'main');
  assert.equal(deploy.deployedAt, '2026-05-29T12:00:00.000Z');
});

test('runtime info exposes app uptime, node env, container status, and database reachability', () => {
  const { getRuntimeInfo } = loadTsModule('../src/lib/runtime-status.ts');

  const runtime = getRuntimeInfo(true, { NODE_ENV: 'production', HOSTNAME: 'newstamhv-app' }, 42.8, new Date('2026-05-29T12:00:00.000Z'));

  assert.equal(runtime.uptimeSeconds, 42);
  assert.equal(runtime.nodeEnv, 'production');
  assert.equal(runtime.containerName, 'newstamhv-app');
  assert.equal(runtime.containerStatus, 'running');
  assert.equal(runtime.dbReachable, true);
  assert.equal(runtime.checkedAt, '2026-05-29T12:00:00.000Z');
});

test('public checks use configured site URL and convert fetch success to readable status', async () => {
  const { getPublicCheckTargets, checkPublicEndpoint } = loadTsModule('../src/lib/runtime-status.ts');
  const targets = getPublicCheckTargets({ PUBLIC_SITE_URL: 'https://example.com/' });

  assert.equal(targets[0].url, 'https://example.com/');
  assert.equal(targets[1].url, 'https://example.com/api/health/live');
  assert.equal(targets[2].url, 'https://example.com/api/articles?limit=1');

  const result = await checkPublicEndpoint(targets[1], async (url) => {
    assert.equal(String(url), 'https://example.com/api/health/live');
    return { ok: true, status: 200 };
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.httpStatus, 200);
  assert.equal(result.key, 'live');
});

test('public checks report failures without throwing the health route', async () => {
  const { checkPublicEndpoint } = loadTsModule('../src/lib/runtime-status.ts');

  const result = await checkPublicEndpoint(
    { key: 'articles', label: 'Danh sách bài public', url: 'https://example.com/api/articles?limit=1' },
    async () => {
      throw new Error('network down');
    }
  );

  assert.equal(result.status, 'failed');
  assert.equal(result.message, 'network down');
});

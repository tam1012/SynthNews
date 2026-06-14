import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadJobLock(fakePool) {
  const source = readFileSync(resolve(__dirname, '../src/lib/jobLock.ts'), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const moduleContext = { exports: {} };
  vm.runInNewContext(outputText, {
    exports: moduleContext.exports,
    module: moduleContext,
    console,
    setImmediate,
    require: (name) => {
      if (name === '../db/index.js') return { pool: fakePool };
      throw new Error(`Unexpected require ${name}`);
    },
  });
  return moduleContext.exports;
}

test('triggerLockedJobInBackground returns already_running when advisory lock is busy', async () => {
  const fakeClient = {
    query: async () => ({ rows: [{ locked: false }] }),
    release: () => {},
  };
  const { triggerLockedJobInBackground } = loadJobLock({ connect: async () => fakeClient });

  const result = await triggerLockedJobInBackground('scrape', async () => {
    throw new Error('job must not run');
  });

  assert.equal(result.name, 'scrape');
  assert.equal(result.status, 'already_running');
});

test('triggerLockedJobInBackground starts job and releases advisory lock after completion', async () => {
  const calls = [];
  const fakeClient = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
      return { rows: [] };
    },
    release: (destroy) => calls.push({ release: destroy }),
  };
  const { triggerLockedJobInBackground } = loadJobLock({ connect: async () => fakeClient });

  let ran = false;
  const result = await triggerLockedJobInBackground('article-fetch', async () => {
    ran = true;
  });

  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(result.name, 'article-fetch');
  assert.equal(result.status, 'started');
  assert.equal(ran, true);
  assert.equal(calls.some((call) => String(call.sql).includes('pg_advisory_unlock')), true);
  assert.equal(calls.at(-1).release, false);
});

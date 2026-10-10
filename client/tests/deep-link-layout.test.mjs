import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

const __dirname = dirname(fileURLToPath(import.meta.url));
const layoutShellSource = readFileSync(resolve(__dirname, '../src/components/layoutShell.ts'), 'utf8');
const routerSource = readFileSync(resolve(__dirname, '../src/router.tsx'), 'utf8');
const { outputText } = ts.transpileModule(layoutShellSource, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
});
const moduleContext = { exports: {} };
vm.runInNewContext(outputText, {
  exports: moduleContext.exports,
  module: moduleContext,
});

const { usesFluidShell } = moduleContext.exports;

test('article deep links use the fluid layout shell', () => {
  assert.equal(usesFluidShell('/article/art_zXtPJ0VQPsQBv-my'), true);
});

test('home feed routes use the fluid layout shell on hard refresh', () => {
  assert.equal(usesFluidShell('/app'), true);
  assert.equal(usesFluidShell('/app/voz'), true);
  assert.equal(usesFluidShell('/app/reddit'), true);
  assert.equal(usesFluidShell('/app/digest'), true);
  assert.equal(usesFluidShell('/app/28052026'), true);
});

test('admin routes keep the fluid layout shell', () => {
  assert.equal(usesFluidShell('/admin'), true);
  assert.equal(usesFluidShell('/sources'), true);
});

test('router serves ddmmyyyy date deep links through the home page under /app', () => {
  assert.match(routerSource, /<Route path="\/app\/:dateSlug" element=\{<Home \/>\} \/>/);
});

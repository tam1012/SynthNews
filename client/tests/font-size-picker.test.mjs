import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function readCssBundle() {
  const stylesDir = resolve(__dirname, '../src/styles');
  const globalCss = readFileSync(resolve(stylesDir, 'global.css'), 'utf8');
  return globalCss.replace(/@import '\.\/(.+?)';/g, (_, file) => readFileSync(resolve(stylesDir, file), 'utf8'));
}

test('font size controls choose an exact size instead of cycling on click', () => {
  const settingsHook = readFileSync(resolve(__dirname, '../src/hooks/useApi.ts'), 'utf8');
  const layoutSource = readFileSync(resolve(__dirname, '../src/components/Layout.tsx'), 'utf8');
  const sidebarSource = readFileSync(resolve(__dirname, '../src/components/Sidebar.tsx'), 'utf8');

  assert.match(settingsHook, /export const FONT_SIZES = \[12, 14, 16, 18, 20\] as const/);
  assert.match(layoutSource, /const \{ fontSize, setFontSize, theme, toggleTheme \} = useSettings\(\)/);
  assert.doesNotMatch(layoutSource, /cycleFontSize/);
  assert.match(layoutSource, /FONT_SIZES\.map\(size =>/);
  assert.match(layoutSource, /onClick=\{\(\) => setFontSize\(size\)\}/);

  assert.match(sidebarSource, /setFontSize\?: \(size: number\) => void/);
  assert.doesNotMatch(sidebarSource, /onClick=\{cycleFontSize\}/);
  assert.match(sidebarSource, /className="sidebar-font-menu"/);
  assert.match(sidebarSource, /onClick=\{\(\) => setFontSize\(size\)\}/);
});

test('desktop hover menu and mobile font grid are styled as direct pickers', () => {
  const css = readCssBundle();

  assert.match(css, /\.sidebar-font-picker:hover \.sidebar-font-menu/);
  assert.match(css, /\.sidebar-font-picker:focus-within \.sidebar-font-menu/);
  assert.match(css, /\.sidebar-font-option\.active/);
  assert.match(css, /\.settings-sheet-font-grid\s*\{[\s\S]*grid-template-columns:\s*repeat\(5, minmax\(0, 1fr\)\)/);
  assert.match(css, /\.settings-sheet-font-option\.active/);
});

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
    exports: moduleContext.exports,
    module: moduleContext,
  });
  return moduleContext.exports;
}

test('admin exposes a dedicated summary queue tab', () => {
  const source = readFileSync(resolve(__dirname, '../src/pages/Admin.tsx'), 'utf8');
  const helpers = readFileSync(resolve(__dirname, '../src/pages/admin/adminHelpers.ts'), 'utf8');

  assert.match(helpers, /export type AdminTab = 'overview' \| 'queue'/);
  assert.match(source, /\{ tab: 'queue', slug: 'queue', label: 'Hàng đợi tóm tắt' \}/);
  assert.match(source, /navigateToTab\('queue'\)/);
  assert.match(source, /tab === 'queue' && <SummaryQueueTab/);
});

test('summary queue filters articles by summary status and shows operational fields', () => {
  const source = readFileSync(resolve(__dirname, '../src/pages/admin/SummaryQueueTab.tsx'), 'utf8');
  const helpers = readFileSync(resolve(__dirname, '../src/pages/admin/adminHelpers.ts'), 'utf8');

  assert.match(helpers, /export type SummaryQueueStatus = 'failed' \| 'pending' \| 'processing' \| 'skipped' \| 'done'/);
  assert.match(source, /api\.getArticles\(\{ page, limit: 50, status \}\)/);
  assert.match(source, /last_summary_error/);
  assert.match(source, /retry_count/);
  assert.match(source, /Tóm tắt lại/);
  assert.match(source, /Chạy tóm tắt/);
});

test('admin overview exposes forum observability labels', () => {
  const source = readFileSync(resolve(__dirname, '../src/pages/admin/OverviewTab.tsx'), 'utf8');

  assert.match(source, /Theo dõi forum Reddit\/VOZ/);
  assert.match(source, /Bỏ qua: ít comment/);
  assert.match(source, /Bỏ qua: ít comment hữu ích/);
  assert.match(source, /Lỗi fetch comment/);
  assert.match(source, /health\.forum\.totals24h/);
});

test('admin overview exposes source quality labels in Vietnamese', () => {
  const source = readFileSync(resolve(__dirname, '../src/pages/admin/OverviewTab.tsx'), 'utf8');

  assert.match(source, /Chất lượng nguồn tin/);
  assert.match(source, /Ít bài mới/);
  assert.match(source, /Đang lỗi/);
  assert.match(source, /Lâu chưa thành công/);
  assert.match(source, /Mở trang Nguồn tin/);
  assert.match(source, /health\.sourceQualitySummary/);
});

test('admin overview exposes system status from deploy runtime and public checks', () => {
  const source = readFileSync(resolve(__dirname, '../src/pages/admin/OverviewTab.tsx'), 'utf8');

  assert.match(source, /Tình trạng hệ thống/);
  assert.match(source, /Đang chạy commit/);
  assert.match(source, /Uptime app/);
  assert.match(source, /Database/);
  assert.match(source, /Public site/);
  assert.match(source, /health\.deploy/);
  assert.match(source, /health\.runtime/);
  assert.match(source, /health\.publicChecks/);
});

test('admin overview uses navigation callbacks owned by the shell', () => {
  const adminSource = readFileSync(resolve(__dirname, '../src/pages/Admin.tsx'), 'utf8');
  const overviewSource = readFileSync(resolve(__dirname, '../src/pages/admin/OverviewTab.tsx'), 'utf8');

  assert.match(adminSource, /actionLoading=\{actionLoading\}/);
  assert.match(adminSource, /goToQuality=\{goToQuality\}/);
  assert.match(overviewSource, /actionLoading: string/);
  assert.match(overviewSource, /goToQuality: \(\) => void/);
  assert.match(overviewSource, /onClick: goToQuality/);
  assert.doesNotMatch(overviewSource, /setTab\(/);
});

test('admin trigger actions expose immediate status feedback', () => {
  const adminSource = readFileSync(resolve(__dirname, '../src/pages/Admin.tsx'), 'utf8');
  const overviewSource = readFileSync(resolve(__dirname, '../src/pages/admin/OverviewTab.tsx'), 'utf8');

  assert.match(adminSource, /const \[actionMessage, setActionMessage\] = useState/);
  assert.match(adminSource, /ADMIN_ACTION_SUCCESS_MESSAGES/);
  assert.match(adminSource, /summarize: 'Đã gửi lệnh tóm tắt bài/);
  assert.match(adminSource, /setActionMessage\(\{ type: 'success'/);
  assert.match(adminSource, /setActionMessage\(\{ type: 'error'/);
  assert.match(adminSource, /actionMessage=\{actionMessage\}/);
  assert.match(overviewSource, /actionMessage: AdminActionMessage \| null/);
  assert.match(overviewSource, /admin-action-message/);
  assert.match(overviewSource, /actionMessage\.message/);
});

test('admin work items are sorted by operational severity', () => {
  const { buildAdminWorkItems } = loadTsModule('../src/pages/admin/adminHelpers.ts');

  assert.equal(typeof buildAdminWorkItems, 'function');
  const items = buildAdminWorkItems({
    runtime: { dbReachable: false },
    publicChecks: [{ key: 'site', status: 'error' }],
    sources: { failing: 2, backed_off: 1 },
    sourceQualitySummary: { stale: 1, low_yield: 1 },
    articleFetchJobs: { failed: 3, retryable_failed: 2, discovered: 12 },
    articles: { failed: 4, retryable_failed: 3, pending: 7, skipped: 5 },
    lastDigest: null,
  });

  assert.deepEqual(
    Array.from(items.slice(0, 4).map((item) => item.severity)),
    ['critical', 'critical', 'critical', 'critical']
  );
  assert.equal(items[0].label, 'Database đang lỗi');
  assert.ok(items.find((item) => item.label === 'Bài tóm tắt lỗi')?.runAction === 'summarize');
  assert.ok(items.find((item) => item.label === 'URL lấy bài lỗi')?.runAction === 'fetch-articles');
  assert.ok(items.find((item) => item.label === 'Bài chờ tóm tắt')?.target === 'queue:pending');
});

test('admin overview renders prioritized work item helper and action buttons', () => {
  const overviewSource = readFileSync(resolve(__dirname, '../src/pages/admin/OverviewTab.tsx'), 'utf8');

  assert.match(overviewSource, /buildAdminWorkItems\(health\)/);
  assert.match(overviewSource, /admin-work-item/);
  assert.match(overviewSource, /runAction/);
  assert.match(overviewSource, /Mức ưu tiên/);
});

type RuntimeEnv = Record<string, string | undefined>;

export type DeployInfo = {
  commit: string | null;
  shortCommit: string | null;
  branch: string | null;
  deployedAt: string | null;
};

export type RuntimeInfo = {
  uptimeSeconds: number;
  nodeEnv: string;
  containerName: string | null;
  containerStatus: 'running';
  dbReachable: boolean;
  checkedAt: string;
};

export type PublicCheckTarget = {
  key: 'frontend' | 'live' | 'articles';
  label: string;
  url: string;
};

export type PublicCheckResult = PublicCheckTarget & {
  status: 'ok' | 'failed';
  httpStatus: number | null;
  responseMs: number;
  message: string;
};

type FetchLike = (url: string, init?: RequestInit) => Promise<{ ok: boolean; status: number }>;

function firstEnv(env: RuntimeEnv, keys: string[]): string | null {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) return value;
  }
  return null;
}

export function getDeployInfo(env: RuntimeEnv = process.env): DeployInfo {
  const commit = firstEnv(env, [
    'GIT_COMMIT',
    'COMMIT_SHA',
    'GITHUB_SHA',
    'SOURCE_COMMIT',
    'SOURCE_VERSION',
  ]);
  const branch = firstEnv(env, [
    'GIT_BRANCH',
    'BRANCH_NAME',
    'GITHUB_REF_NAME',
    'SOURCE_BRANCH',
  ]);

  return {
    commit,
    shortCommit: commit ? commit.slice(0, 7) : null,
    branch,
    deployedAt: firstEnv(env, ['DEPLOYED_AT', 'BUILD_TIME', 'BUILD_DATE']),
  };
}

export function getRuntimeInfo(
  dbReachable: boolean,
  env: RuntimeEnv = process.env,
  uptimeSeconds = process.uptime(),
  now = new Date()
): RuntimeInfo {
  return {
    uptimeSeconds: Math.max(0, Math.floor(uptimeSeconds)),
    nodeEnv: env.NODE_ENV || 'development',
    containerName: firstEnv(env, ['CONTAINER_NAME', 'HOSTNAME']),
    containerStatus: 'running',
    dbReachable,
    checkedAt: now.toISOString(),
  };
}

function publicBaseUrl(env: RuntimeEnv): string {
  const base = firstEnv(env, ['PUBLIC_SITE_URL', 'APP_PUBLIC_URL', 'SITE_URL']) || 'https://synthnews.site';
  return base.replace(/\/+$/, '');
}

function joinPublicUrl(base: string, path: string): string {
  if (path === '/') return `${base}/`;
  return `${base}${path}`;
}

export function getPublicCheckTargets(env: RuntimeEnv = process.env): PublicCheckTarget[] {
  const base = publicBaseUrl(env);
  return [
    { key: 'frontend', label: 'Trang đọc tin public', url: joinPublicUrl(base, '/') },
    { key: 'live', label: 'Live API', url: joinPublicUrl(base, '/api/health/live') },
    { key: 'articles', label: 'Danh sách bài public', url: joinPublicUrl(base, '/api/articles?limit=1') },
  ];
}

export async function checkPublicEndpoint(
  target: PublicCheckTarget,
  fetchImpl: FetchLike = fetch
): Promise<PublicCheckResult> {
  const started = Date.now();
  try {
    const res = await fetchImpl(target.url, {
      method: 'GET',
      headers: { Accept: 'application/json,text/html;q=0.9,*/*;q=0.8' },
      signal: AbortSignal.timeout(8000),
    });
    const responseMs = Date.now() - started;
    return {
      ...target,
      status: res.ok ? 'ok' : 'failed',
      httpStatus: res.status,
      responseMs,
      message: res.ok ? 'OK' : `HTTP ${res.status}`,
    };
  } catch (err: any) {
    return {
      ...target,
      status: 'failed',
      httpStatus: null,
      responseMs: Date.now() - started,
      message: err?.message || 'Public check failed',
    };
  }
}

export async function getPublicChecks(
  env: RuntimeEnv = process.env,
  fetchImpl: FetchLike = fetch
): Promise<PublicCheckResult[]> {
  return Promise.all(getPublicCheckTargets(env).map((target) => checkPublicEndpoint(target, fetchImpl)));
}


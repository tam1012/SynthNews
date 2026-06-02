# Local production-like testing

Use `https://synthnews.local` to test local changes without overriding production `https://synthnews.site`.

## One-time setup

1. Install Caddy.
2. Add this line to `C:\Windows\System32\drivers\etc\hosts` as Administrator:

```text
127.0.0.1 synthnews.local
```

3. Check hosts:

```powershell
npm run local:check-hosts
```

4. Copy env template and fill local secrets:

```powershell
Copy-Item .env.local.example .env.local
```

At minimum, set `ADMIN_TOKEN`. Keep `.env.local` uncommitted.

5. Docker Compose now fails fast when required production-style variables are
   missing. Create a local Compose env file before starting Postgres:

```powershell
Copy-Item .env.example .env
```

Set at least these local values in `.env`:

```text
DB_PASSWORD=newstamhv_secret
ADMIN_TOKEN=change-me-local-admin-token
PUBLIC_SITE_URL=https://synthnews.local
CORS_ORIGIN=https://synthnews.local
```

Keep `.env` uncommitted. If you change `DB_PASSWORD`, also update
`DATABASE_URL` in `.env.local` to use the same password.

6. Start local Postgres. Existing Docker Compose exposes DB at `127.0.0.1:5433`:

```powershell
docker compose up -d db
```

## Run production-like local app

Terminal 1:

```powershell
npm run local:prod
```

Terminal 2:

```powershell
caddy run --config Caddyfile.local
```

Open:

```text
https://synthnews.local
```

If browser warns about certificate, trust Caddy local CA or continue only for this local domain.

## Verify before commit/push

```powershell
npm test --workspace=client
npm test --workspace=server
npm run build
```

Manual checks:

- `https://synthnews.local/api/health/live` returns success.
- Home feed loads.
- `/sources` loads.
- `/admin` loads with the system status and action cards visible.
- Admin write actions use local `ADMIN_TOKEN` and update the visible state without browser refresh.
- Article detail routes load via SPA fallback.
- `https://synthnews.site` still opens VPS production.

## Release checklist

Run this when a change is ready to leave local testing:

1. Local checks pass:

```powershell
npm test --workspace=client
npm test --workspace=server
npm run build
```

2. Production-like local smoke passes at `https://synthnews.local`:
   - Home feed, article detail, `/sources`, and `/admin` render without console errors.
   - Desktop and mobile screenshots show no clipped text, overlapping controls, or broken admin cards.
   - `https://synthnews.local/api/health/live` returns success.

3. After push/deploy:
   - GitHub Actions deploy is `success`.
   - VPS repo is at the pushed commit:

```powershell
ssh -i "C:\Users\Ha Tam\Downloads\ssh-key-2026-04-20_tamhvt.key" ubuntu@158.178.239.119 "cd /home/ubuntu/newstamhv && git log --oneline -1"
```

4. Production smoke:

```powershell
curl.exe -fsS https://synthnews.site/ | Select-Object -First 1
curl.exe -fsS https://synthnews.site/api/health/live
curl.exe -fsS "https://synthnews.site/api/articles?limit=1"
```

## Docker app parity

If running full app container, Docker exposes the app at `127.0.0.1:3001`. Change `Caddyfile.local` proxy target from `127.0.0.1:3000` to `127.0.0.1:3001`.

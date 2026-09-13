# Scrapling Watchdog And Fresh Queue Design

## Problem

SynthNews still discovers sources and occasionally completes articles, but the fetch queue is no longer fresh. Two Chromium trees have outlived their requests by days, permanently occupying the Scrapling thread pool. The sidecar returns timeout responses but cannot cancel the underlying executor threads, while `/health` continues to report success. The queue then processes old work first and broad block-triggered residential-proxy retries spend several minutes on sites that are unlikely to succeed.

## Design

Keep the existing sidecar and Docker restart policy, but make a browser timeout process-fatal. After returning a 504, the sidecar schedules a clean process exit; `restart: unless-stopped` replaces the process and all descendant browsers. Health reports a 503 while that restart is pending and exposes the oldest in-flight request age so saturation is visible.

Residential proxy use becomes allowlist-first. Proactive domains in `SCRAPLING_PROXY_DOMAINS` continue to use the proxy, but broad escalation of every blocked host is disabled by default behind `SCRAPLING_BLOCK_TRIGGERED_PROXY_ENABLED=false`. This preserves an opt-in escape hatch without spending proxy bandwidth or worker time on arbitrary AP, NYTimes, and similar failures.

The article fetch queue expires stale discovered work and claims fresh work first. The freshness window is configurable and defaults to 36 hours. The VPS-local fetch limits are moved into tracked Compose configuration so deployments reproduce the intended bounded runtime.

## Error Handling And Recovery

- DNS validation timeouts remain ordinary 504 responses and do not restart the sidecar.
- A timeout from the browser executor schedules exactly one exit and marks health unhealthy until exit.
- Stale queue jobs become `skipped` with a stable reason instead of being retried forever.
- Existing successful Yahoo, MSN, Google News, VOZ, and direct HTTP paths are unchanged.

## Verification

- Python unit tests prove browser timeouts schedule one restart and health changes to 503.
- Node regression tests prove proxy escalation is off by default, allowlisted proxy routing remains active, and queue SQL expires stale work and claims newest first.
- Build and focused test suites run locally.
- After push, verify GitHub Actions, VPS commit, sidecar process age/health, backlog trend, and fresh articles through the public API.

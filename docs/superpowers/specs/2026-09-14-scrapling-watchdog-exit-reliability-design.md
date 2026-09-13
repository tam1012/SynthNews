# Scrapling Watchdog Exit Reliability Design

## Problem

The Scrapling watchdog marks the sidecar unhealthy after a browser executor
timeout, then starts a `threading.Timer` that should terminate the process. A
browser leak can already have exhausted the container PID limit at that point.
Creating the timer thread then raises `RuntimeError: can't start new thread`,
but `_restart_scheduled` has already been set. The sidecar remains alive and
returns HTTP 503 forever, while Docker never restarts it because the process did
not exit.

## Selected Approach

Schedule `os._exit(1)` with the running asyncio event loop instead of creating a
new thread. `loop.call_later` does not consume another PID/task and the event loop
is demonstrably still running when the sidecar continues serving health checks.

The restart scheduler will:

1. Return without scheduling again when a restart is already pending.
2. Obtain the running event loop and register the delayed exit callback.
3. Set `_restart_scheduled` only after callback registration succeeds.
4. If callback registration itself fails, log the failure and call
   `os._exit(1)` immediately so the process cannot remain falsely pending.

The HTTP request normally has the configured short delay to return its 504
response before the process exits. Docker's existing `restart: unless-stopped`
policy then recreates the sidecar and reaps leaked browser descendants.

## Alternatives Considered

- Keep `threading.Timer` and roll back the flag if `start()` fails. This avoids
  the permanent 503 but leaves the wedged process alive and cannot guarantee a
  later request has enough PID capacity to retry.
- Exit immediately in the timeout exception handler. This is robust but usually
  cuts off the 504 response and produces a less useful connection error in the
  application logs.
- Add an auto-heal container that restarts unhealthy services. This adds another
  privileged operational component for a failure the sidecar can resolve itself.

## Tests

The watchdog test suite will cover:

- a browser executor timeout schedules exactly one restart;
- thread creation failure cannot prevent scheduling, proving the regression;
- health returns 503 only while a real exit callback is pending;
- failure to register the event-loop callback triggers immediate process exit;
- repeated scheduling calls remain idempotent.

Run the Scrapling watchdog unit tests first, then the full sidecar tests and the
relevant server Scrapling-fetch tests. After deployment, verify the GitHub
Actions result, VPS commit, sidecar container health/restart count, and the
application's authenticated admin health data without exposing credentials.

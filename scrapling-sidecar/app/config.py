import os

TIMEOUT_MS = int(os.environ.get("SCRAPLING_TIMEOUT_MS", "60000"))
PORT = int(os.environ.get("SCRAPLING_PORT", "8000"))
WORKERS = int(os.environ.get("SCRAPLING_WORKERS", "1"))
SERVICE_TOKEN = os.environ.get("SCRAPLING_SERVICE_TOKEN", "")
# Max simultaneous browser launches inside this worker. Each StealthyFetcher
# launch spawns a Camoufox/Firefox tree; unbounded concurrency under a burst of
# VOZ/Reddit fetches forked thousands of PIDs and pinned host CPU at 300%+.
MAX_CONCURRENCY = int(os.environ.get("SCRAPLING_MAX_CONCURRENCY", "2"))

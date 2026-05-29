import time
import asyncio
from typing import Optional
from concurrent.futures import ThreadPoolExecutor

from fastapi import FastAPI
from pydantic import BaseModel

from .config import TIMEOUT_MS, MAX_CONCURRENCY

app = FastAPI(title="Scrapling Sidecar", version="1.0.0")

_start_time = time.time()
# Bound the thread pool to MAX_CONCURRENCY so we never have more than N browser
# launches in flight per worker. The semaphore is belt-and-suspenders: it gates
# at the async layer before a thread is even claimed, so queued requests wait
# instead of piling browser processes onto the host.
_executor = ThreadPoolExecutor(max_workers=MAX_CONCURRENCY)
_fetch_semaphore = asyncio.Semaphore(MAX_CONCURRENCY)


class FetchOptions(BaseModel):
    wait_selector: Optional[str] = None
    wait_ms: Optional[int] = None
    block_resources: Optional[bool] = True
    raw_text: Optional[bool] = False
    timeout_ms: Optional[int] = None
    proxy: Optional[str] = None
    solve_cloudflare: Optional[bool] = False


class FetchRequest(BaseModel):
    url: str
    mode: str = "stealth"
    options: FetchOptions = FetchOptions()


class FetchResponse(BaseModel):
    ok: bool
    html: Optional[str] = None
    error: Optional[str] = None
    status_code: int = 200
    elapsed_ms: int = 0


@app.get("/health")
async def health():
    return {
        "ok": True,
        "version": "1.0.0",
        "uptime_s": int(time.time() - _start_time),
        "max_concurrency": MAX_CONCURRENCY,
        "in_flight": MAX_CONCURRENCY - _fetch_semaphore._value,
    }


@app.post("/fetch", response_model=FetchResponse)
async def fetch(req: FetchRequest):
    start = time.time()
    timeout = req.options.timeout_ms or TIMEOUT_MS

    try:
        async with _fetch_semaphore:
            loop = asyncio.get_event_loop()
            if req.mode == "stealth":
                html = await loop.run_in_executor(_executor, _stealth_fetch_sync, req.url, req.options, timeout)
            else:
                html = await loop.run_in_executor(_executor, _fast_fetch_sync, req.url, req.options, timeout)

        elapsed = int((time.time() - start) * 1000)

        if req.options.raw_text and html:
            try:
                from scrapling import Selector as _Parser
            except ImportError:
                from scrapling import Adaptor as _Parser
            page = _Parser(html, auto_match=False)
            text = page.get_all_text(separator="\n")
            return FetchResponse(ok=True, html=text, status_code=200, elapsed_ms=elapsed)

        return FetchResponse(ok=True, html=html, status_code=200, elapsed_ms=elapsed)

    except Exception as e:
        elapsed = int((time.time() - start) * 1000)
        return FetchResponse(ok=False, error=str(e), status_code=403, elapsed_ms=elapsed)


def _stealth_fetch_sync(url: str, options: FetchOptions, timeout_ms: int) -> str:
    from scrapling.fetchers import StealthyFetcher

    kwargs = {
        "headless": True,
        "disable_resources": bool(options.block_resources),
        "timeout": timeout_ms,
        "google_search": True,
    }

    if options.solve_cloudflare:
        kwargs["solve_cloudflare"] = True
        # solve_cloudflare needs the page fully loaded — don't strip resources
        kwargs["disable_resources"] = False
    else:
        # network_idle slows VOZ thread reads from 17s to 200s once Cloudflare
        # is in the way; only enable it when the caller skips solve_cloudflare.
        kwargs["network_idle"] = True

    if options.wait_ms and options.wait_ms > 0:
        kwargs["wait"] = options.wait_ms

    if options.wait_selector:
        kwargs["wait_selector"] = options.wait_selector

    if options.proxy:
        from urllib.parse import urlparse
        parsed = urlparse(options.proxy)
        proxy_cfg = {"server": f"{parsed.scheme}://{parsed.hostname}:{parsed.port}"}
        if parsed.username:
            proxy_cfg["username"] = parsed.username
        if parsed.password:
            proxy_cfg["password"] = parsed.password
        kwargs["proxy"] = proxy_cfg

    page = StealthyFetcher.fetch(url, **kwargs)

    return page.html_content if hasattr(page, "html_content") else (page.body if hasattr(page, "body") else str(page))


def _fast_fetch_sync(url: str, options: FetchOptions, timeout_ms: int) -> str:
    from scrapling.fetchers import Fetcher

    kwargs = {
        "timeout": timeout_ms / 1000,
    }

    if options.proxy:
        kwargs["proxies"] = {"https": options.proxy, "http": options.proxy}

    page = Fetcher.get(url, **kwargs)
    return page.html_content if hasattr(page, "html_content") else str(page)

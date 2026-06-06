import time
import asyncio
import ipaddress
import secrets
import socket
from typing import Optional
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlparse

from fastapi import FastAPI, Header, Response
from pydantic import BaseModel, Field

from .config import TIMEOUT_MS, MAX_CONCURRENCY, SERVICE_TOKEN

app = FastAPI(title="Scrapling Sidecar", version="1.0.0")

_start_time = time.time()
# Bound the thread pool to MAX_CONCURRENCY so we never have more than N browser
# launches in flight per worker. The semaphore is belt-and-suspenders: it gates
# at the async layer before a thread is even claimed, so queued requests wait
# instead of piling browser processes onto the host.
_executor = ThreadPoolExecutor(max_workers=MAX_CONCURRENCY)
_fetch_semaphore = asyncio.Semaphore(MAX_CONCURRENCY)
_in_flight = 0
_in_flight_lock = asyncio.Lock()


class UrlValidationError(ValueError):
    pass


class DnsResolutionError(RuntimeError):
    pass


class FetchOptions(BaseModel):
    wait_selector: Optional[str] = None
    wait_ms: Optional[int] = None
    block_resources: Optional[bool] = True
    raw_text: Optional[bool] = False
    timeout_ms: Optional[int] = None
    proxy: Optional[str] = None
    solve_cloudflare: Optional[bool] = False
    # Light-render levers for residential-proxied hosts (Bloomberg). block_resources
    # is all-or-nothing and strips websocket/beacon/stylesheet too — that kills the
    # PerimeterX sensor channel and the challenge fails. These are surgical instead:
    #   block_media  — abort only image/media/font requests via a page_setup route,
    #                  keeping document/script/xhr/fetch/websocket/stylesheet so the
    #                  challenge JS still runs. Cuts proxy bandwidth per article.
    #   block_ads    — scrapling's built-in ~3500 ad/tracker domain blocklist.
    #   network_idle — override the default. On PerimeterX/Cloudflare hosts the page
    #                  never goes network-idle (beacons/long-poll stay open), so the
    #                  default True waits until timeout. Set False to return as soon
    #                  as the document settles instead of hanging ~250s.
    block_media: Optional[bool] = False
    block_ads: Optional[bool] = False
    network_idle: Optional[bool] = None


class FetchRequest(BaseModel):
    url: str
    mode: str = "stealth"
    options: FetchOptions = Field(default_factory=FetchOptions)


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
        "in_flight": _in_flight,
        "auth_configured": bool(SERVICE_TOKEN),
    }


@app.post("/fetch", response_model=FetchResponse)
async def fetch(
    req: FetchRequest,
    response: Response,
    x_sidecar_token: Optional[str] = Header(default=None, alias="X-Sidecar-Token"),
):
    start = time.time()
    timeout = req.options.timeout_ms or TIMEOUT_MS

    try:
        if SERVICE_TOKEN and not secrets.compare_digest(x_sidecar_token or "", SERVICE_TOKEN):
            response.status_code = 401
            return FetchResponse(ok=False, error="Unauthorized sidecar request", status_code=401, elapsed_ms=0)

        await asyncio.wait_for(asyncio.to_thread(validate_public_http_url, req.url), timeout=5)

        async with _fetch_semaphore:
            await _increment_in_flight()
            try:
                loop = asyncio.get_running_loop()
                fetcher = _stealth_fetch_sync if req.mode == "stealth" else _fast_fetch_sync
                html = await asyncio.wait_for(
                    loop.run_in_executor(_executor, fetcher, req.url, req.options, timeout),
                    timeout=max(1, timeout / 1000) + 5,
                )
            finally:
                await _decrement_in_flight()

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

    except UrlValidationError as e:
        elapsed = int((time.time() - start) * 1000)
        response.status_code = 400
        return FetchResponse(ok=False, error=str(e), status_code=400, elapsed_ms=elapsed)
    except DnsResolutionError as e:
        elapsed = int((time.time() - start) * 1000)
        response.status_code = 502
        return FetchResponse(ok=False, error=str(e), status_code=502, elapsed_ms=elapsed)
    except asyncio.TimeoutError:
        elapsed = int((time.time() - start) * 1000)
        response.status_code = 504
        return FetchResponse(ok=False, error="Fetch timed out", status_code=504, elapsed_ms=elapsed)
    except Exception as e:
        elapsed = int((time.time() - start) * 1000)
        status_code = _classify_fetch_error(e)
        response.status_code = status_code
        return FetchResponse(ok=False, error=_safe_error_message(e), status_code=status_code, elapsed_ms=elapsed)


async def _increment_in_flight() -> None:
    global _in_flight
    async with _in_flight_lock:
        _in_flight += 1


async def _decrement_in_flight() -> None:
    global _in_flight
    async with _in_flight_lock:
        _in_flight = max(0, _in_flight - 1)


def validate_public_http_url(url: str) -> None:
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise UrlValidationError("URL must use http or https")

    hostname = (parsed.hostname or "").rstrip(".").lower()
    if not hostname:
        raise UrlValidationError("URL must include a hostname")
    if "%" in hostname:
        raise UrlValidationError("URL host zone identifiers are not allowed")
    if hostname == "localhost" or hostname.endswith(".localhost") or hostname.endswith(".local"):
        raise UrlValidationError("Local hostnames are not allowed")

    try:
        _assert_safe_ip(hostname)
        return
    except ValueError:
        pass

    if _looks_like_obfuscated_ip(hostname):
        raise UrlValidationError("Ambiguous numeric IP hostnames are not allowed")

    try:
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
    except ValueError as e:
        raise UrlValidationError("URL port is invalid") from e

    try:
        addresses = socket.getaddrinfo(hostname, port, type=socket.SOCK_STREAM)
    except socket.gaierror as e:
        raise DnsResolutionError(f"DNS resolution failed for {hostname}") from e

    if not addresses:
        raise DnsResolutionError(f"DNS resolution returned no addresses for {hostname}")

    for family, _socktype, _proto, _canonname, sockaddr in addresses:
        ip_value = sockaddr[0]
        try:
            _assert_safe_ip(ip_value)
        except UrlValidationError as e:
            raise UrlValidationError(f"URL host resolves to a blocked address: {ip_value}") from e


def _assert_safe_ip(ip_value: str) -> None:
    ip = ipaddress.ip_address(ip_value)
    if ip.version == 4 and str(ip) == "169.254.169.254":
        raise UrlValidationError("Cloud metadata IP addresses are not allowed")
    if not ip.is_global:
        raise UrlValidationError("Private, local, reserved, or non-global IP addresses are not allowed")


def _looks_like_obfuscated_ip(hostname: str) -> bool:
    parts = hostname.split(".")
    compact = "".join(parts)
    return (
        compact.isdigit()
        or hostname.startswith("0x")
        or any(part.startswith("0x") for part in parts)
    )


def _classify_fetch_error(exc: Exception) -> int:
    message = str(exc).lower()
    if "timeout" in message or "timed out" in message:
        return 504
    if "dns" in message or "name resolution" in message or "temporary failure" in message:
        return 502
    if "blocked" in message or "captcha" in message or "cloudflare" in message or "access denied" in message:
        return 403
    return 502


def _safe_error_message(exc: Exception) -> str:
    message = str(exc).strip() or exc.__class__.__name__
    return message[:500]


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
        # network_idle waits for the network to fall quiet for 500ms. That never
        # happens on anti-bot sites: PerimeterX/DataDome keep beacons + long-polls
        # open after the article is painted, so the fetch stalls until it hits the
        # timeout (the same trap noted for VOZ: 17s reads ballooning to 200s+).
        # Default it on (safe for plain sites), but let the caller force it off for
        # hard-proxied hosts where the body is present long before the net idles.
        if options.network_idle is None:
            kwargs["network_idle"] = True
        else:
            kwargs["network_idle"] = bool(options.network_idle)

    # Block ~3,500 known ad/tracker domains. Cheap bandwidth win that never touches
    # the document/script the anti-bot challenge needs, so it's always safe.
    if options.block_ads:
        kwargs["block_ads"] = True

    # block_media is the surgical alternative to disable_resources: abort only
    # image/media/font requests via a pre-navigation route, while letting
    # document/script/xhr/fetch/websocket/stylesheet through. disable_resources is
    # all-or-nothing and also drops websocket/beacon/stylesheet — which starves the
    # PerimeterX sensor channel and made Bloomberg 504 on 2026-06-05. This keeps the
    # challenge JS alive while still shedding the heavy bytes over a metered proxy.
    if options.block_media:
        _BLOCK_RESOURCE_TYPES = {"image", "media", "font"}

        def _page_setup(page):
            def _route_handler(route):
                try:
                    if route.request.resource_type in _BLOCK_RESOURCE_TYPES:
                        route.abort()
                    else:
                        route.continue_()
                except Exception:
                    try:
                        route.continue_()
                    except Exception:
                        pass
            page.route("**/*", _route_handler)

        kwargs["page_setup"] = _page_setup

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

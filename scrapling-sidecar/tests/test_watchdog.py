import asyncio
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch


SIDECAR_ROOT = Path(__file__).resolve().parents[1]
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

os.environ.setdefault("SCRAPLING_SERVICE_TOKEN", "test-sidecar-token")

from app import main  # noqa: E402


class BrowserTimeoutWatchdogTests(unittest.IsolatedAsyncioTestCase):
    async def asyncTearDown(self):
        main._restart_scheduled = False
        main._active_fetches.clear()
        main._next_fetch_id = 0

    async def test_browser_executor_timeout_schedules_process_restart(self):
        never_finishes = asyncio.get_running_loop().create_future()

        with patch.object(main, "_schedule_restart_after_timeout") as schedule_restart:
            with self.assertRaises(main.BrowserFetchTimeout):
                await main._await_browser_result(never_finishes, timeout_ms=1)

        schedule_restart.assert_called_once_with()

    async def test_health_is_unhealthy_while_restart_is_pending(self):
        response = main.Response()
        main._restart_scheduled = True

        payload = await main.health(response)

        self.assertEqual(response.status_code, 503)
        self.assertFalse(payload["ok"])
        self.assertTrue(payload["restart_pending"])

    async def test_health_reports_oldest_in_flight_request_age(self):
        token = await main._increment_in_flight(timeout_ms=60_000)

        payload = await main.health(main.Response())

        self.assertEqual(payload["in_flight"], 1)
        self.assertIsNotNone(payload["oldest_in_flight_s"])
        self.assertGreaterEqual(payload["oldest_in_flight_s"], 0)
        await main._decrement_in_flight(token)


class RestartSchedulingTests(unittest.TestCase):
    def tearDown(self):
        main._restart_scheduled = False

    def test_restart_is_scheduled_only_once(self):
        timers = []

        class FakeTimer:
            def __init__(self, delay, callback, args=()):
                self.delay = delay
                self.callback = callback
                self.args = args
                self.daemon = False
                timers.append(self)

            def start(self):
                return None

        with patch.object(main.threading, "Timer", FakeTimer):
            first = main._schedule_restart_after_timeout()
            second = main._schedule_restart_after_timeout()

        self.assertTrue(first)
        self.assertFalse(second)
        self.assertEqual(len(timers), 1)
        self.assertTrue(timers[0].daemon)


if __name__ == "__main__":
    unittest.main()

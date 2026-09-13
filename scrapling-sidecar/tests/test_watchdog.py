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


class RestartSchedulingTests(unittest.IsolatedAsyncioTestCase):
    async def asyncTearDown(self):
        main._restart_scheduled = False

    async def test_restart_does_not_require_starting_a_thread(self):
        with (
            patch("threading.Timer", side_effect=RuntimeError("can't start new thread")) as timer,
            patch.object(main.os, "_exit") as process_exit,
        ):
            scheduled = main._schedule_restart_after_timeout()
            await asyncio.sleep((main.RESTART_DELAY_MS / 1000) + 0.05)

        self.assertTrue(scheduled)
        timer.assert_not_called()
        process_exit.assert_called_once_with(1)

    async def test_restart_is_scheduled_only_once(self):
        with patch.object(main.os, "_exit") as process_exit:
            first = main._schedule_restart_after_timeout()
            second = main._schedule_restart_after_timeout()
            await asyncio.sleep((main.RESTART_DELAY_MS / 1000) + 0.05)

        self.assertTrue(first)
        self.assertFalse(second)
        process_exit.assert_called_once_with(1)

    async def test_restart_exits_immediately_when_event_loop_scheduling_fails(self):
        with (
            patch.object(
                main.asyncio,
                "get_running_loop",
                side_effect=RuntimeError("event loop unavailable"),
            ),
            patch.object(main.os, "_exit") as process_exit,
        ):
            scheduled = main._schedule_restart_after_timeout()

        self.assertTrue(scheduled)
        self.assertFalse(main._restart_scheduled)
        process_exit.assert_called_once_with(1)


if __name__ == "__main__":
    unittest.main()

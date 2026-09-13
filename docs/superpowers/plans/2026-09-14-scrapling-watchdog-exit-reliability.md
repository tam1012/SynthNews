# Kế hoạch triển khai watchdog thoát tiến trình Scrapling tin cậy

> **Dành cho agent triển khai:** BẮT BUỘC dùng `superpowers:subagent-driven-development` (khuyến nghị) hoặc `superpowers:executing-plans` để thực hiện lần lượt từng task. Mỗi bước dùng checkbox (`- [ ]`) để theo dõi.

**Mục tiêu:** Bảo đảm Scrapling luôn thoát tiến trình sau browser timeout, kể cả khi container đã cạn PID/task, để Docker có thể tự dựng lại sidecar.

**Kiến trúc:** Watchdog sẽ đăng ký `os._exit(1)` bằng timer của asyncio event loop hiện tại thay vì tạo `threading.Timer`. Cờ `_restart_scheduled` chỉ được bật sau khi đăng ký callback thành công; nếu event loop không đăng ký được callback, watchdog gọi `os._exit(1)` ngay để không mắc vĩnh viễn ở HTTP 503.

**Công nghệ:** Python 3.11, asyncio, FastAPI, unittest, Docker Compose.

---

## Cấu trúc file thay đổi

- Sửa `scrapling-sidecar/app/main.py`: thay cách lập lịch thoát tiến trình của watchdog.
- Sửa `scrapling-sidecar/tests/test_watchdog.py`: bổ sung regression test cho cạn thread/PID, fallback khi event loop lỗi và tính idempotent.

### Task 1: Tạo regression test tái hiện lỗi cạn thread/PID

**Files:**
- Sửa: `scrapling-sidecar/tests/test_watchdog.py`
- Test: `scrapling-sidecar/tests/test_watchdog.py`

- [ ] **Bước 1: Viết test thất bại chứng minh watchdog không được phụ thuộc vào thread mới**

Thay test `RestartSchedulingTests.test_restart_is_scheduled_only_once` bằng các test async sau. Test đầu cố tình làm `threading.Timer` ném đúng lỗi đã tái hiện ở production; hành vi mong muốn vẫn phải lên lịch thoát bằng event loop:

```python
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
```

- [ ] **Bước 2: Chạy test để xác nhận RED**

Chạy:

```powershell
python -m unittest scrapling-sidecar/tests/test_watchdog.py -v
```

Kỳ vọng: test `test_restart_does_not_require_starting_a_thread` lỗi với `RuntimeError: can't start new thread`, vì implementation hiện tại vẫn dùng `threading.Timer`.

- [ ] **Bước 3: Commit riêng regression test**

```powershell
git add scrapling-sidecar/tests/test_watchdog.py
git commit -m "test(scrapling): reproduce watchdog thread exhaustion"
```

### Task 2: Thay timer thread bằng asyncio event-loop timer

**Files:**
- Sửa: `scrapling-sidecar/app/main.py:1-15`
- Sửa: `scrapling-sidecar/app/main.py:180-195`
- Test: `scrapling-sidecar/tests/test_watchdog.py`

- [ ] **Bước 1: Viết test thất bại cho đường fallback khi event loop không nhận callback**

Thêm vào `RestartSchedulingTests`:

```python
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
```

- [ ] **Bước 2: Chạy riêng test fallback để xác nhận RED**

Chạy:

```powershell
python -m unittest scrapling-sidecar.tests.test_watchdog.RestartSchedulingTests.test_restart_exits_immediately_when_event_loop_scheduling_fails -v
```

Kỳ vọng: FAIL vì implementation hiện tại không gọi `asyncio.get_running_loop()` và vẫn đặt `_restart_scheduled=True`.

- [ ] **Bước 3: Viết implementation tối thiểu**

Xóa `import threading`. Thay `_schedule_restart_after_timeout` bằng:

```python
def _schedule_restart_after_timeout() -> bool:
    global _restart_scheduled
    if _restart_scheduled:
        return False

    delay_s = RESTART_DELAY_MS / 1000
    try:
        loop = asyncio.get_running_loop()
        loop.call_later(delay_s, os._exit, 1)
    except Exception as exc:
        print(
            f"Unable to schedule sidecar restart ({_safe_error_message(exc)}); exiting immediately",
            file=sys.stderr,
            flush=True,
        )
        os._exit(1)
        return True

    _restart_scheduled = True
    print(
        f"Browser executor timed out; exiting sidecar in {delay_s:.3f}s so Docker can recycle leaked browser processes",
        file=sys.stderr,
        flush=True,
    )
    return True
```

- [ ] **Bước 4: Chạy watchdog test để xác nhận GREEN**

Chạy:

```powershell
python -m unittest scrapling-sidecar/tests/test_watchdog.py -v
```

Kỳ vọng: toàn bộ test PASS, không có traceback ngoài các log watchdog chủ động.

- [ ] **Bước 5: Commit implementation**

```powershell
git add scrapling-sidecar/app/main.py scrapling-sidecar/tests/test_watchdog.py
git commit -m "fix(scrapling): schedule watchdog exit without new thread"
```

### Task 3: Kiểm tra hồi quy local

**Files:**
- Kiểm tra: `scrapling-sidecar/app/main.py`
- Kiểm tra: `scrapling-sidecar/tests/test_watchdog.py`
- Kiểm tra: `server/tests/scrapling-fetch.test.mjs`

- [ ] **Bước 1: Chạy toàn bộ Python test của sidecar**

```powershell
python -m unittest discover -s scrapling-sidecar/tests -v
```

Kỳ vọng: tất cả test PASS.

- [ ] **Bước 2: Chạy test phía server gọi Scrapling**

```powershell
npm test --workspace=server -- --test-name-pattern=Scrapling
```

Nếu Node test runner không lọc đúng theo tên trên Windows, chạy file trực tiếp:

```powershell
node --test server/tests/scrapling-fetch.test.mjs
```

Kỳ vọng: tất cả test trong `scrapling-fetch.test.mjs` PASS.

- [ ] **Bước 3: Chạy build đầy đủ**

```powershell
npm run build
```

Kỳ vọng: client Vite build và server TypeScript build đều exit code 0.

- [ ] **Bước 4: Kiểm tra diff cuối**

```powershell
git diff main...HEAD --check
git diff main...HEAD --stat
git status --short
```

Kỳ vọng: không có whitespace error; chỉ có plan, test và implementation thuộc scope.

### Task 4: Tích hợp, deploy tự động và xác minh production

**Files:**
- Không sửa thêm file.

- [ ] **Bước 1: Đưa các commit đã kiểm tra vào `main`**

Từ working tree chính:

```powershell
git merge --ff-only fix/scrapling-watchdog
```

Kỳ vọng: fast-forward, không conflict và không đụng các file local-only chưa track.

- [ ] **Bước 2: Chạy verification cuối trên `main` rồi push**

```powershell
python -m unittest discover -s scrapling-sidecar/tests -v
node --test server/tests/scrapling-fetch.test.mjs
npm run build
git push origin main
```

Kỳ vọng: test/build đều exit code 0 và push thành công; GitHub Actions tự deploy.

- [ ] **Bước 3: Theo dõi GitHub Actions đến trạng thái kết thúc**

```powershell
gh run list --workflow deploy.yml --branch main --limit 1
gh run watch <run-id> --exit-status
```

Kỳ vọng: workflow deploy kết thúc `success`.

- [ ] **Bước 4: Xác minh live state trên VPS**

Qua SSH, kiểm tra:

```bash
cd /home/ubuntu/newstamhv
git log --oneline -1
docker compose ps scrapling app
docker inspect newstamhv-scrapling --format '{{json .State.Health}}'
docker compose exec -T app node -e 'fetch("http://scrapling:8000/health").then(async r=>console.log(r.status,await r.text()))'
```

Kỳ vọng: VPS ở đúng commit mới; `scrapling` và `app` đều healthy; health nội bộ trả HTTP 200 với `ok=true`, `restart_pending=false`.

- [ ] **Bước 5: Xác minh cảnh báo admin biến mất qua dữ liệu health**

Dùng endpoint admin health có xác thực sẵn trong phiên trình duyệt hoặc gọi nội bộ ứng dụng, không in credential. Kỳ vọng trường `scrapling` có `configured=true`, `ok=true`, nên `buildAdminWorkItems` không sinh mục `Scrapling sidecar lỗi`.

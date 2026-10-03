"""Khởi động server cho lệnh `python -m app`.

Tắt bản server cũ của chính dự án trên cổng 8000 trước khi bind, để file .env
mới được nạp. Không đụng tới tiến trình khác đang giữ cổng.
"""

import os
import re
import subprocess
import sys
import time

from .config import ROOT_DIR, settings

HOST = "127.0.0.1"
PORT = 8000
_CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
_LAUNCHER = re.compile(r"(?:^|\s)-m app(?:\s|$)")


def is_our_launcher(command: str) -> bool:
    text = " ".join(command.lower().split())
    if "app.main:app" in text:
        return True
    return _LAUNCHER.search(text) is not None


def find_server_root(listener_pid: int, command_of, parent_of) -> int | None:
    """Đi ngược từ tiến trình đang nghe cổng tới process cha đã chạy lệnh của dự án."""
    current = listener_pid
    root: int | None = None
    seen: set[int] = set()
    for _ in range(8):
        if current in seen or current <= 0:
            break
        seen.add(current)
        if is_our_launcher(command_of(current)):
            root = current
        parent = parent_of(current)
        if not parent or parent == current:
            break
        current = parent
    return root


def _run_powershell(script: str) -> str:
    completed = subprocess.run(
        ["powershell", "-NoProfile", "-Command", script],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
        creationflags=_CREATE_NO_WINDOW,
    )
    return completed.stdout or ""


def listening_pids(port: int) -> list[int]:
    script = (
        f"(Get-NetTCPConnection -LocalPort {int(port)} -State Listen "
        "-ErrorAction SilentlyContinue).OwningProcess"
    )
    pids: list[int] = []
    for line in _run_powershell(script).splitlines():
        line = line.strip()
        if line.isdigit():
            pids.append(int(line))
    return list(dict.fromkeys(pids))


def _process_info(pid: int) -> tuple[int | None, str]:
    script = f"""
$p = Get-CimInstance Win32_Process -Filter 'ProcessId={int(pid)}'
if ($null -eq $p) {{ exit 0 }}
Write-Output $p.ParentProcessId
Write-Output $p.CommandLine
"""
    lines = _run_powershell(script).splitlines()
    if not lines:
        return None, ""
    try:
        parent = int(lines[0].strip())
    except ValueError:
        parent = None
    return parent, "\n".join(lines[1:]).strip()


def stop_previous_server(port: int = PORT) -> None:
    pids = listening_pids(port)
    if not pids:
        return
    roots: list[int] = []
    for pid in pids:
        root = find_server_root(
            pid,
            lambda current: _process_info(current)[1],
            lambda current: _process_info(current)[0],
        )
        if root is None:
            occupied = ", ".join(str(item) for item in pids)
            raise SystemExit(
                f"Cổng {port} đang bị tiến trình khác chiếm (PID {occupied}). "
                "Hãy tắt tiến trình đó rồi chạy lại."
            )
        roots.append(root)
    for root in dict.fromkeys(roots):
        subprocess.run(
            ["taskkill", "/PID", str(root), "/T", "/F"],
            capture_output=True,
            check=False,
            creationflags=_CREATE_NO_WINDOW,
        )
    deadline = time.time() + 8
    while time.time() < deadline:
        if not listening_pids(port):
            print(f"Đã tắt server cũ trên cổng {port} để nạp lại file .env.")
            return
        time.sleep(0.3)
    raise SystemExit(f"Không giải phóng được cổng {port}. Hãy tắt server cũ rồi chạy lại.")


def main() -> None:
    os.chdir(ROOT_DIR)
    if str(ROOT_DIR) not in sys.path:
        sys.path.insert(0, str(ROOT_DIR))
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")

    if settings.gemini_api_key:
        print(
            f"Gemini đã cấu hình. Não: {settings.brain_model}. "
            f"Nhắn tin: {settings.fast_model}. Giọng nói: {settings.live_model}."
        )
    else:
        print(
            "Chưa có GEMINI_API_KEY trong file .env. Giao diện vẫn mở, "
            "nhưng tải tài liệu và phỏng vấn sẽ lỗi cho đến khi điền key rồi chạy lại lệnh này.",
            file=sys.stderr,
        )

    stop_previous_server(PORT)
    print(f"Mở http://{HOST}:{PORT}")

    import uvicorn

    uvicorn.run(
        "app.main:app",
        host=HOST,
        port=PORT,
        reload=True,
        reload_dirs=[str(ROOT_DIR / "app")],
    )

from app.serve import find_server_root, is_our_launcher
from app.voice import live_model_chain


def test_launcher_matches_project_commands_only():
    assert is_our_launcher(r"C:\app\.venv\Scripts\python.exe -m uvicorn app.main:app --reload")
    assert is_our_launcher(r"C:\app\.venv\Scripts\python.exe -m app")
    assert not is_our_launcher(r"C:\app\.venv\Scripts\python.exe -m apple")
    assert not is_our_launcher("python.exe -c from multiprocessing.spawn import spawn_main")


def test_find_server_root_walks_up_to_the_launcher():
    processes = {
        10: (0, r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"),
        20: (10, r"C:\proj\.venv\Scripts\python.exe -m app"),
        30: (20, r"C:\proj\.venv\Scripts\python.exe -c from multiprocessing.spawn import spawn_main"),
    }

    root = find_server_root(30, lambda pid: processes[pid][1], lambda pid: processes[pid][0])

    assert root == 20
    assert find_server_root(99, lambda _pid: "nginx", lambda _pid: None) is None


def test_live_model_chain_keeps_the_connected_model_on_resume():
    assert live_model_chain("gemini-3.8-live") == [
        "gemini-3.8-live",
        "gemini-3.1-flash-live-preview",
        "gemini-2.5-flash-native-audio-latest",
    ]
    assert live_model_chain("gemini-3.8-live", active="gemini-3.1-flash-live-preview") == [
        "gemini-3.1-flash-live-preview"
    ]

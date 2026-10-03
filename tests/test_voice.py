"""Kiểm tra cầu nối giọng nói với một phiên Gemini Live giả phát lại kịch bản hội thoại."""

import asyncio
import json
from types import SimpleNamespace

from google.genai import types

import app.voice as voice_module

TURN_GAP_S = 0.15


def model_turn(learner: str | None, interviewer: str) -> list[types.LiveServerMessage]:
    messages = []
    if learner:
        messages.append(
            types.LiveServerMessage(
                server_content=types.LiveServerContent(input_transcription=types.Transcription(text=learner))
            )
        )
    messages.append(
        types.LiveServerMessage(
            server_content=types.LiveServerContent(
                output_transcription=types.Transcription(text=interviewer),
                model_turn=types.Content(
                    parts=[types.Part(inline_data=types.Blob(data=b"\x01\x00\x02\x00", mime_type="audio/pcm"))]
                ),
            )
        )
    )
    messages.append(types.LiveServerMessage(server_content=types.LiveServerContent(turn_complete=True)))
    return messages


class FakeLiveSession:
    def __init__(self, script: list[list[types.LiveServerMessage]]):
        self.script = script
        self.client_content: list[tuple[str, bool]] = []
        self.audio_chunks = 0

    async def send_client_content(self, turns, turn_complete=True):
        self.client_content.append((turns.parts[0].text, turn_complete))

    async def send_realtime_input(self, audio=None, **_):
        self.audio_chunks += 1

    async def receive(self):
        if not self.script:
            await asyncio.Event().wait()
        # Để bộ não chạy ngầm kịp xử lý lượt trước, giống nhịp hội thoại thật.
        await asyncio.sleep(TURN_GAP_S)
        for message in self.script.pop(0):
            yield message


class FakeConnection:
    def __init__(self, live):
        self.live = live

    async def __aenter__(self):
        return self.live

    async def __aexit__(self, *exc):
        return False


def test_voice_bridge_runs_full_interview(client, document, monkeypatch):
    live = FakeLiveSession(
        [
            model_turn(None, "Chào Lan. A là gì?"),
            model_turn("Câu trả lời tốt về A", "Mình hiểu rồi. Bạn cho ví dụ nhé?"),
            model_turn("Ví dụ về A", "Cảm ơn bạn. Giờ sang B: B là gì?"),
            model_turn("Câu trả lời tốt về B", "Mình hiểu rồi."),
            model_turn("Dạ", "Cảm ơn Lan, buổi trò chuyện kết thúc."),
        ]
    )
    fake_client = SimpleNamespace(
        aio=SimpleNamespace(live=SimpleNamespace(connect=lambda model, config: FakeConnection(live)))
    )
    monkeypatch.setattr(voice_module, "get_client", lambda: fake_client)

    session = client.post(
        "/api/sessions", json={"document_id": document["id"], "learner_name": "Lan", "mode": "voice"}
    ).json()["session"]

    events: list[str] = []
    audio_frames = 0
    with client.websocket_connect(f"/api/sessions/{session['id']}/voice") as ws:
        ws.send_bytes(b"\x00\x00" * 640)
        while True:
            message = ws.receive()
            if message.get("bytes"):
                audio_frames += 1
                continue
            event = json.loads(message["text"])
            events.append(event["type"])
            assert event["type"] != "error", event
            if event["type"] == "session_ended":
                break
        ws.send_text(json.dumps({"type": "end"}))

    assert audio_frames == 5
    assert events.count("turn_complete") == 5
    assert live.audio_chunks == 1

    opening, *notes = live.client_content
    assert opening[1] is True and opening[0].startswith("[CHỈ THỊ ẨN]")
    assert [turn_complete for _, turn_complete in notes] == [False, False]
    assert "chủ đề mới" in notes[0][0] and "Concept B" in notes[0][0]
    assert "kết thúc" in notes[1][0]

    insights = client.get(f"/api/sessions/{session['id']}/insights").json()
    assert insights["status"] == "finished"
    by_id = {c["id"]: c for c in insights["concepts"]}
    # Câu "Ví dụ về A" đến trước khi AI chuyển chủ đề nên vẫn được tính cho A.
    assert by_id["c1"]["evidence_count"] == 2
    assert by_id["c2"]["evidence_count"] == 2
    assert by_id["c1"]["status"] == by_id["c2"]["status"] == "mastered"

    turns = client.get(f"/api/sessions/{session['id']}").json()["turns"]
    assert [t["role"] for t in turns] == ["interviewer"] + ["learner", "interviewer"] * 4

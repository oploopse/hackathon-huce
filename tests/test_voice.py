"""Kiểm tra cầu nối giọng nói với một phiên Gemini Live giả phát lại kịch bản hội thoại."""

import asyncio
import json
from types import SimpleNamespace

from google.genai import types

import app.voice as voice_module
from app.prompts import VOICE_SOURCE_CHARS, render_voice_note, voice_concept_context, voice_system_instruction
from app.schemas import Chunk, Directive

from .factories import make_concept, make_doc, make_eval

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
            model_turn("A", "Mình hiểu rồi. Bạn cho ví dụ nhé?"),
            model_turn("Ví dụ về A", "Cảm ơn bạn. Giờ sang B: B là gì?"),
            model_turn("Câu trả lời tốt về B", "Mình hiểu rồi."),
            model_turn("Dạ", "Cảm ơn Lan, buổi trò chuyện kết thúc."),
        ]
    )
    configs = []

    def connect(model, config):
        configs.append(config)
        return FakeConnection(live)

    fake_client = SimpleNamespace(aio=SimpleNamespace(live=SimpleNamespace(connect=connect)))
    monkeypatch.setattr(voice_module, "get_client", lambda: fake_client)
    monkeypatch.setattr(voice_module.settings, "vad_silence_ms", 1500)
    monkeypatch.setattr(voice_module.settings, "vad_prefix_padding_ms", 100)

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
    vad = configs[0].realtime_input_config.automatic_activity_detection
    assert vad.start_of_speech_sensitivity == types.StartSensitivity.START_SENSITIVITY_HIGH
    assert vad.end_of_speech_sensitivity == types.EndSensitivity.END_SENSITIVITY_LOW
    assert vad.silence_duration_ms == 1500
    assert vad.prefix_padding_ms == 100
    assert "Nội dung bài học." in configs[0].system_instruction

    opening, *notes = live.client_content
    assert opening[1] is True and opening[0].startswith("[CHỈ THỊ ẨN]")
    assert [turn_complete for _, turn_complete in notes] == [False, False]
    assert "chủ đề mới" in notes[0][0] and "Concept B" in notes[0][0]
    assert "Nội dung bài học." in notes[0][0]
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
    assert turns[1]["text"] == "A"
    short_answer = next(ev for ev in insights["evaluations"] if ev["answer"] == "A")
    assert short_answer["question"] == "Chào Lan. A là gì?"


def test_voice_source_context_follows_current_concept():
    first, second = make_concept("c1"), make_concept("c2")
    second.source_chunks = ["ch2"]
    doc = make_doc(first, second)
    doc.chunks = [
        Chunk(id="ch1", text="Loại trừ lẫn nhau (mutual exclusion)."),
        Chunk(id="ch2", text="Bế tắc (deadlock) là trạng thái các tiến trình chờ nhau."),
        Chunk(id="ch3", text="Nội dung không thuộc chủ đề đang hỏi."),
    ]

    opening = voice_system_instruction(doc, "Lan", first)
    assert "mutual exclusion" in opening
    # Danh sách thuật ngữ lấy từ cả tài liệu, nhưng trích đoạn nguồn chỉ thuộc chủ đề đang hỏi.
    assert "là trạng thái các tiến trình chờ nhau" not in opening
    note = render_voice_note(
        Directive(action="next_concept", concept_id="c2", question="Bế tắc là gì?"),
        second, make_eval(), doc,
    )
    assert "deadlock" in note
    assert "mutual exclusion" not in note
    assert "Nội dung không thuộc chủ đề" not in note


def test_voice_source_context_is_bounded_and_handles_missing_references():
    concept = make_concept("c1")
    concept.source_chunks = ["missing", "ch1", "ch1", "ch2"]
    doc = make_doc(concept)
    doc.chunks = [
        Chunk(id="ch1", text="A" * (VOICE_SOURCE_CHARS - 10)),
        Chunk(id="ch2", text="B" * 20 + "OUTSIDE_BUDGET"),
    ]
    context = voice_concept_context(doc, concept)
    assert context.count("[ch1]") == 1
    assert "B" * 10 in context and "B" * 11 not in context
    assert "OUTSIDE_BUDGET" not in context

    concept.source_chunks = ["missing"]
    context = voice_concept_context(doc, concept)
    assert concept.name in context
    assert "Trích đoạn tài liệu gốc" not in context


def test_voice_bridge_drops_rejected_config_options(client, document, monkeypatch):
    from google.genai import errors

    live = FakeLiveSession([model_turn(None, "Chào Lan."), model_turn("Dạ", "Cảm ơn Lan, buổi trò chuyện kết thúc.")])
    configs = []

    def connect(model, config):
        configs.append(config)
        if len(configs) == 1:
            raise errors.APIError(1007, {"error": {"message": "thinking not supported"}})
        return FakeConnection(live)

    fake_client = SimpleNamespace(aio=SimpleNamespace(live=SimpleNamespace(connect=connect)))
    monkeypatch.setattr(voice_module, "get_client", lambda: fake_client)
    monkeypatch.setattr(voice_module.settings, "live_thinking_budget", 0)

    session = client.post(
        "/api/sessions", json={"document_id": document["id"], "learner_name": "Lan", "mode": "voice"}
    ).json()["session"]
    with client.websocket_connect(f"/api/sessions/{session['id']}/voice") as ws:
        while True:
            event = json.loads(ws.receive()["text"])
            assert event["type"] != "error", event
            if event["type"] == "status":
                break
        ws.send_text(json.dumps({"type": "end"}))

    assert configs[0].thinking_config is not None
    assert configs[0].input_audio_transcription.language_codes == ["vi-VN", "en-US"]
    # Lần hai bỏ thinking nhưng vẫn giữ gợi ý ngôn ngữ cho nhận dạng giọng nói.
    assert configs[1].thinking_config is None
    assert configs[1].input_audio_transcription.language_codes == ["vi-VN", "en-US"]
    assert configs[1].speech_config.language_code == "vi-VN"

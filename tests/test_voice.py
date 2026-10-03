"""Kiểm tra cầu nối giọng nói với một phiên Gemini Live giả phát lại kịch bản hội thoại."""

import asyncio
import json
from types import SimpleNamespace

from google.genai import types

import app.voice as voice_module
import app.main as main
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
        self.groups_seen = 0

    async def send_client_content(self, turns, turn_complete=True):
        self.client_content.append((turns.parts[0].text, turn_complete))

    async def send_realtime_input(self, audio=None, **_):
        self.audio_chunks += 1

    async def receive(self):
        if not self.script:
            await asyncio.Event().wait()
        # Gemini chỉ nói câu tiếp theo sau khi nhận quyết định từ bộ não.
        if self.groups_seen in {2, 4}:
            required_messages = 2 if self.groups_seen == 2 else 3
            async def wait_for_note():
                while len(self.client_content) < required_messages:
                    await asyncio.sleep(0.01)
            await asyncio.wait_for(wait_for_note(), timeout=2)
        await asyncio.sleep(TURN_GAP_S)
        self.groups_seen += 1
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
            model_turn("A", "Mình hiểu rồi."),
            model_turn(None, "Cảm ơn bạn. B là gì?"),
            model_turn("Câu trả lời tốt về B", "Mình hiểu rồi."),
            model_turn(None, "Cảm ơn Lan, buổi trò chuyện kết thúc."),
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
    assert vad.start_of_speech_sensitivity == types.StartSensitivity.START_SENSITIVITY_LOW
    assert vad.end_of_speech_sensitivity == types.EndSensitivity.END_SENSITIVITY_LOW
    assert vad.silence_duration_ms == 1500
    assert vad.prefix_padding_ms == 100
    assert "Nội dung bài học." in configs[0].system_instruction

    opening, *notes = live.client_content
    assert opening[1] is True and opening[0].startswith("[CHỈ THỊ ẨN]")
    assert [turn_complete for _, turn_complete in notes] == [True, True]
    assert "chủ đề mới" in notes[0][0] and "Concept B" in notes[0][0]
    assert "Nội dung bài học." in notes[0][0]
    assert "kết thúc" in notes[1][0]

    internal = main.store.get_session(session["id"])
    assert internal.status == "finished"
    assert internal.progress["c1"].evidence_count == 1
    assert internal.progress["c2"].evidence_count == 1
    assert internal.progress["c1"].status == internal.progress["c2"].status == "mastered"

    turns = client.get(f"/api/sessions/{session['id']}").json()["turns"]
    assert [t["role"] for t in turns] == ["interviewer", "learner", "interviewer", "interviewer", "learner", "interviewer", "interviewer"]
    assert turns[1]["text"] == "A"
    short_answer = next(ev for ev in internal.evaluations if ev.answer == "A")
    assert short_answer.question == "A là gì?"


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
    assert "deadlock" not in opening
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


def test_normal_probe_is_sent_as_a_question():
    note = render_voice_note(
        Directive(action="probe_deeper", concept_id="c1", question="Bạn có thể cho ví dụ không?"),
        make_concept("c1"), make_eval(), make_doc(make_concept("c1")),
    )
    assert "Bạn có thể cho ví dụ không?" in note
    assert "Chỉ hỏi câu này" in note


def test_dropped_audio_is_not_graded(client, document):
    class Socket:
        def __init__(self):
            self.messages = []

        async def send_text(self, message):
            self.messages.append(json.loads(message))

    session_id = client.post(
        "/api/sessions", json={"document_id": document["id"], "mode": "voice"}
    ).json()["session"]["id"]
    session = main.store.get_session(session_id)
    bridge = voice_module.VoiceBridge(Socket(), main.engine, session, main.store.get_document(document["id"]))
    bridge.audio_in = asyncio.Queue(maxsize=1)
    bridge._enqueue_audio(b"old")
    bridge._enqueue_audio(b"new")
    bridge.learner_buf.append("một đoạn transcript thiếu")
    bridge._complete_turn()
    turn = bridge.turns.get_nowait()
    asyncio.run(bridge._process_turn(*turn))

    saved = main.store.get_session(session_id)
    assert not saved.evaluations
    assert saved.progress[saved.current_concept_id].evidence_count == 0
    assert "nhắc lại" in bridge.pending_note
    assert any(event["type"] == "warning" for event in bridge.ws.messages)

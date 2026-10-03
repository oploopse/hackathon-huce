"""Cầu nối WebSocket giữa trình duyệt và Gemini Live.

Trình duyệt gửi PCM 16-bit 16 kHz (binary frame) và nhận PCM 24 kHz của AI (binary frame)
cùng các sự kiện JSON: transcript, interrupted, turn_complete, status, warning, error, session_ended.
"""

import asyncio
import json
import logging

from fastapi import WebSocket, WebSocketDisconnect
from google.genai import errors, types

from .config import settings
from .interview.engine import InterviewEngine
from .llm import LLMError, LLMNotConfigured, get_client
from .prompts import render_voice_note
from .schemas import DocumentRecord, SessionRecord

log = logging.getLogger(__name__)

INPUT_MIME = "audio/pcm;rate=16000"
AUDIO_QUEUE_MAX = 250  # khoảng 10 giây audio với chunk 40 ms
MAX_RECONNECTS = 3
END_GRACE_S = 30
TRANSIENT_CLOSE_CODES = {1000, 1001, 1006}


def describe_live_error(exc: errors.APIError) -> str:
    if exc.code in {429, 1011}:
        return (
            f"Gemini Live báo hết quota hoặc đang quá tải (mã {exc.code}). Free tier giới hạn theo project; "
            "hãy thử lại sau ít phút hoặc đổi LIVE_MODEL trong file .env."
        )
    if exc.code in {400, 401, 403, 404, 1007, 1008}:
        return (
            f"Gemini Live từ chối kết nối (mã {exc.code}): {exc.message}. "
            "Kiểm tra GEMINI_API_KEY và LIVE_MODEL trong file .env."
        )
    return f"Kết nối Gemini Live bị đóng (mã {exc.code}): {exc.message}"


class VoiceBridge:
    def __init__(self, ws: WebSocket, engine: InterviewEngine, session: SessionRecord, doc: DocumentRecord):
        self.ws = ws
        self.engine = engine
        self.session = session
        self.doc = doc
        self.system_instruction, self.opening = engine.voice_prompts(session, doc)

        self.audio_in: asyncio.Queue[bytes] = asyncio.Queue(maxsize=AUDIO_QUEUE_MAX)
        self.turns: asyncio.Queue[tuple[int, str, str, str, bool]] = asyncio.Queue()
        self.closed = asyncio.Event()
        self.send_lock = asyncio.Lock()

        self.live = None
        self.pending_note: str | None = None
        self.resume_handle: str | None = None
        self.turn_counter = 0
        self.wrap_up_turn: int | None = None
        self.active_question = session.last_question
        self.audio_dropped = False
        self.learner_buf: list[str] = []
        self.interviewer_buf: list[str] = []
        self.model_spoke = False

    # -- Vòng đời --------------------------------------------------------------

    async def run(self) -> None:
        self.engine.active_voice.add(self.session.id)
        helpers = [asyncio.create_task(self._read_browser()), asyncio.create_task(self._brain_worker())]
        gemini = asyncio.create_task(self._gemini_loop())
        closed_wait = asyncio.create_task(self.closed.wait())
        try:
            await asyncio.wait({gemini, closed_wait}, return_when=asyncio.FIRST_COMPLETED)
        finally:
            gemini.cancel()
            closed_wait.cancel()
            try:
                await asyncio.wait_for(self.turns.join(), timeout=END_GRACE_S)
            except asyncio.TimeoutError:
                log.warning("Hết thời gian chờ chấm các lượt còn lại của phiên %s", self.session.id)
            for task in helpers:
                task.cancel()
            async with self.engine.lock(self.session.id):
                self.engine.store.save_session(self.session)
            self.engine.active_voice.discard(self.session.id)
            try:
                await self.ws.close()
            except Exception:
                pass

    async def _send(self, payload: dict) -> None:
        try:
            async with self.send_lock:
                await self.ws.send_text(json.dumps(payload, ensure_ascii=False))
        except Exception:
            # Trình duyệt đã ngắt kết nối; mỗi server ASGI báo lỗi bằng một kiểu exception khác nhau.
            self.closed.set()

    async def _send_audio(self, data: bytes) -> None:
        try:
            async with self.send_lock:
                await self.ws.send_bytes(data)
        except Exception:
            self.closed.set()

    # -- Trình duyệt -> Gemini -------------------------------------------------

    async def _read_browser(self) -> None:
        try:
            while True:
                message = await self.ws.receive()
                if message["type"] == "websocket.disconnect":
                    break
                if message.get("bytes"):
                    self._enqueue_audio(message["bytes"])
                elif message.get("text"):
                    if json.loads(message["text"]).get("type") == "end":
                        break
        except (WebSocketDisconnect, RuntimeError, json.JSONDecodeError):
            pass
        finally:
            self.closed.set()

    def _enqueue_audio(self, chunk: bytes) -> None:
        if self.audio_in.full():
            self.audio_in.get_nowait()
            self.audio_dropped = True
        self.audio_in.put_nowait(chunk)

    async def _pump_audio(self, live) -> None:
        try:
            while True:
                chunk = await self.audio_in.get()
                await live.send_realtime_input(audio=types.Blob(data=chunk, mime_type=INPUT_MIME))
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            # Kết nối Gemini đã đóng; vòng nhận sẽ báo lỗi hoặc nối lại.
            log.info("Ngừng gửi audio cho phiên %s: %s", self.session.id, exc)

    # -- Gemini -> trình duyệt -------------------------------------------------

    def _live_config(self) -> types.LiveConnectConfig:
        return types.LiveConnectConfig(
            response_modalities=[types.Modality.AUDIO],
            system_instruction=self.system_instruction,
            speech_config=types.SpeechConfig(
                voice_config=types.VoiceConfig(
                    prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name=settings.live_voice)
                )
            ),
            input_audio_transcription=types.AudioTranscriptionConfig(),
            output_audio_transcription=types.AudioTranscriptionConfig(),
            realtime_input_config=types.RealtimeInputConfig(
                automatic_activity_detection=types.AutomaticActivityDetection(
                    start_of_speech_sensitivity=types.StartSensitivity.START_SENSITIVITY_LOW,
                    end_of_speech_sensitivity=types.EndSensitivity.END_SENSITIVITY_LOW,
                    prefix_padding_ms=settings.vad_prefix_padding_ms,
                    silence_duration_ms=settings.vad_silence_ms,
                )
            ),
            context_window_compression=types.ContextWindowCompressionConfig(sliding_window=types.SlidingWindow()),
            session_resumption=types.SessionResumptionConfig(handle=self.resume_handle),
        )

    async def _gemini_loop(self) -> None:
        try:
            await self._run_gemini()
        except LLMNotConfigured as exc:
            await self._send({"type": "error", "message": str(exc)})
        except Exception:
            log.exception("Lỗi không mong đợi trong phiên voice %s", self.session.id)
            await self._send({"type": "error", "message": "Lỗi không mong đợi ở máy chủ, xem log để biết chi tiết."})

    async def _send_note(self, live, note: str) -> None:
        await live.send_client_content(
            turns=types.Content(role="user", parts=[types.Part(text=note)]), turn_complete=True
        )

    async def _run_gemini(self) -> None:
        client = get_client()
        opening_sent = False
        reconnects = 0
        while not self.closed.is_set():
            resume = False
            try:
                async with client.aio.live.connect(model=settings.live_model, config=self._live_config()) as live:
                    self.live = live
                    await self._send({"type": "status", "state": "connected"})
                    if not opening_sent:
                        await live.send_client_content(
                            turns=types.Content(role="user", parts=[types.Part(text=self.opening)]),
                            turn_complete=True,
                        )
                        opening_sent = True
                    if self.pending_note:
                        await self._send_note(live, self.pending_note)
                        self.pending_note = None
                    pump = asyncio.create_task(self._pump_audio(live))
                    try:
                        resume = await self._receive_loop(live)
                    finally:
                        pump.cancel()
                        self.live = None
            except errors.APIError as exc:
                if exc.code in TRANSIENT_CLOSE_CODES and self.resume_handle and reconnects < MAX_RECONNECTS:
                    resume = True
                else:
                    log.warning("Gemini Live lỗi %s: %s", exc.code, exc.message)
                    await self._send({"type": "error", "message": describe_live_error(exc)})
                    return
            if not resume or not self.resume_handle or reconnects >= MAX_RECONNECTS:
                return
            reconnects += 1
            self._drop_stale_audio()
            await self._send({"type": "status", "state": "reconnecting"})
            log.info("Nối lại Gemini Live cho phiên %s (lần %d)", self.session.id, reconnects)

    def _drop_stale_audio(self) -> None:
        if not self.audio_in.empty():
            self.audio_dropped = True
        while not self.audio_in.empty():
            self.audio_in.get_nowait()

    async def _receive_loop(self, live) -> bool:
        """Chuyển phản hồi của Gemini về trình duyệt. Trả về True khi cần nối lại (server gửi GoAway)."""
        while not self.closed.is_set():
            async for message in live.receive():
                update = message.session_resumption_update
                if update and update.resumable and update.new_handle:
                    self.resume_handle = update.new_handle
                if message.go_away is not None:
                    return True
                content = message.server_content
                if content is None:
                    continue
                if content.input_transcription and content.input_transcription.text:
                    self.learner_buf.append(content.input_transcription.text)
                    await self._send(
                        {"type": "transcript", "role": "learner", "text": content.input_transcription.text}
                    )
                if content.output_transcription and content.output_transcription.text:
                    self.interviewer_buf.append(content.output_transcription.text)
                    await self._send(
                        {"type": "transcript", "role": "interviewer", "text": content.output_transcription.text}
                    )
                if content.model_turn:
                    for part in content.model_turn.parts or []:
                        if part.inline_data and part.inline_data.data:
                            self.model_spoke = True
                            await self._send_audio(part.inline_data.data)
                if content.interrupted:
                    await self._send({"type": "interrupted"})
                    self._complete_turn()
                if content.turn_complete:
                    await self._send({"type": "turn_complete"})
                    self._complete_turn()
        return False

    def _complete_turn(self) -> None:
        learner_text = "".join(self.learner_buf).strip()
        interviewer_text = "".join(self.interviewer_buf).strip()
        spoke = self.model_spoke
        dropped_audio = self.audio_dropped
        self.learner_buf.clear()
        self.interviewer_buf.clear()
        self.model_spoke = False
        self.audio_dropped = False
        if not (learner_text or interviewer_text or spoke or dropped_audio):
            return
        self.turn_counter += 1
        self.turns.put_nowait(
            (self.turn_counter, learner_text, interviewer_text, self.active_question, dropped_audio)
        )

    # -- Bộ não chạy ngầm ------------------------------------------------------

    async def _brain_worker(self) -> None:
        while True:
            turn_no, learner_text, interviewer_text, question, dropped_audio = await self.turns.get()
            try:
                await self._process_turn(turn_no, learner_text, interviewer_text, question, dropped_audio)
            except Exception:
                log.exception("Lỗi khi xử lý lượt %d của phiên %s", turn_no, self.session.id)
            finally:
                self.turns.task_done()

    async def _process_turn(
        self, turn_no: int, learner_text: str, interviewer_text: str,
        question: str, dropped_audio: bool,
    ) -> None:
        note: str | None = None
        directive = None
        async with self.engine.lock(self.session.id):
            concept_id = self.session.current_concept_id
            if dropped_audio:
                note = (
                    "[CHỈ THỊ ẨN] Một phần âm thanh câu trả lời đã bị mất. "
                    "Nói rằng bạn chưa nghe rõ và xin người học nhắc lại; không gợi ý đáp án."
                )
            elif learner_text:
                self.engine.record_turn(self.session, "learner", learner_text)
                try:
                    evaluation, directive = await self.engine.process_answer(
                        self.session, self.doc, question, learner_text,
                        defer_switch=False,
                    )
                except LLMError as exc:
                    log.warning("Không chấm được lượt %d: %s", turn_no, exc)
                    await self._send({"type": "warning", "message": "Chưa đánh giá được câu trả lời; hãy nói lại sau một lát."})
                    evaluation = directive = None
                    note = (
                        "[CHỈ THỊ ẨN] Hệ thống tạm thời chưa xử lý được câu trả lời vừa rồi. "
                        f'Xin người học nhắc lại và hỏi lại đúng câu: "{question}". Không gợi ý đáp án.'
                    )
                if directive:
                    concept = self.doc.concept(directive.concept_id) if directive.concept_id else None
                    note = render_voice_note(directive, concept, evaluation, self.doc)
            if interviewer_text:
                self.engine.record_turn(
                    self.session, "interviewer", interviewer_text,
                    concept_id=concept_id, update_question=False,
                )
            self.engine.store.save_session(self.session)

        if self.wrap_up_turn is not None and turn_no > self.wrap_up_turn:
            await self._end_session()
            return
        if note:
            if dropped_audio:
                await self._send({"type": "warning", "message": "Âm thanh bị gián đoạn; hãy nhắc lại câu trả lời."})
            if self.live is not None:
                await self._send_note(self.live, note)
            else:
                self.pending_note = note
            if directive and directive.question:
                self.active_question = directive.question
                async with self.engine.lock(self.session.id):
                    self.session.last_question = directive.question
                    self.engine.store.save_session(self.session)
            if directive and directive.action == "wrap_up":
                self.wrap_up_turn = self.turn_counter

    async def _end_session(self) -> None:
        async with self.engine.lock(self.session.id):
            self.engine.finish(self.session)
            self.engine.store.save_session(self.session)
        await self._send({"type": "session_ended"})
        # Chờ trình duyệt phát hết lời chào rồi tự đóng; nếu không thì đóng sau END_GRACE_S giây.
        asyncio.get_running_loop().call_later(END_GRACE_S, self.closed.set)

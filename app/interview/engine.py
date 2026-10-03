import asyncio

from ..config import settings
from ..prompts import opening_note, voice_opening_instruction, voice_system_instruction
from ..schemas import (
    ConceptProgress,
    Directive,
    DocumentRecord,
    EvaluationRecord,
    Report,
    SessionRecord,
    Turn,
    TurnEvaluation,
    utcnow,
)
from ..storage import JsonStore, new_id
from . import director
from .evaluator import evaluate_answer
from .interviewer import generate_utterance
from .report import generate_report

HISTORY_PER_CONCEPT = 4
VOICE_DRAIN_TIMEOUT_S = 30


class SessionNotFound(LookupError):
    pass


class SessionFinished(RuntimeError):
    pass


class InterviewEngine:
    def __init__(self, store: JsonStore):
        self.store = store
        self.active_voice: set[str] = set()
        self._locks: dict[str, asyncio.Lock] = {}

    def lock(self, session_id: str) -> asyncio.Lock:
        return self._locks.setdefault(session_id, asyncio.Lock())

    def _load(self, session_id: str) -> SessionRecord:
        session = self.store.get_session(session_id)
        if session is None:
            raise SessionNotFound(session_id)
        return session

    # -- Tạo phiên -------------------------------------------------------------

    def create_session(self, doc: DocumentRecord, learner_name: str, mode: str) -> SessionRecord:
        order = director.plan_concept_order(doc.knowledge_map, settings.max_concepts_per_session)
        session = SessionRecord(
            id=new_id(),
            document_id=doc.id,
            learner_name=learner_name,
            mode=mode,
            concept_order=order,
            progress={cid: ConceptProgress(concept_id=cid) for cid in order},
        )
        director.switch_concept(session, order[0])
        session.progress[order[0]].asked_questions.append(director.first_question(doc.concept(order[0])))
        if mode == "voice":
            session.last_question = director.first_question(doc.concept(order[0]))
        session.last_action = "ask_main"
        return session

    async def start_text_session(self, doc: DocumentRecord, learner_name: str) -> tuple[SessionRecord, str]:
        session = self.create_session(doc, learner_name, "text")
        concept = doc.concept(session.current_concept_id)
        directive = Directive(
            action="ask_main",
            concept_id=concept.id,
            question=director.first_question(concept),
            note=opening_note(learner_name, doc.knowledge_map.title, settings.interview_minutes),
        )
        reply = await generate_utterance(session, doc, directive)
        self.record_turn(session, "interviewer", reply)
        self.store.save_session(session)
        return session, reply

    def start_voice_session(self, doc: DocumentRecord, learner_name: str) -> SessionRecord:
        session = self.create_session(doc, learner_name, "voice")
        self.store.save_session(session)
        return session

    def voice_prompts(self, session: SessionRecord, doc: DocumentRecord) -> tuple[str, str]:
        """Trả về (system instruction, chỉ thị mở đầu) cho một kết nối Gemini Live mới."""
        concept = doc.concept(session.current_concept_id)
        system = voice_system_instruction(doc, session.learner_name, concept)
        if session.turns:
            opening = (
                "[CHỈ THỊ ẨN] Kết nối vừa bị gián đoạn và đã được nối lại. Xin lỗi ngắn gọn rồi hỏi lại câu: "
                f'"{session.last_question}"'
            )
        else:
            opening = voice_opening_instruction(
                session.learner_name, doc.knowledge_map.title, settings.interview_minutes,
                director.first_question(concept),
            )
        return system, opening

    # -- Xử lý từng lượt -------------------------------------------------------

    def record_turn(
        self, session: SessionRecord, role: str, text: str, *,
        concept_id: str | None = None, update_question: bool = True,
    ) -> None:
        session.turns.append(Turn(role=role, text=text, concept_id=concept_id or session.current_concept_id))
        if role == "interviewer" and update_question:
            session.last_question = text

    async def process_answer(
        self,
        session: SessionRecord,
        doc: DocumentRecord,
        question: str,
        answer: str,
        defer_switch: bool,
        note_applied: bool = True,
    ) -> tuple[TurnEvaluation, Directive | None]:
        """Chấm một câu trả lời, cập nhật mức hiểu và (nếu cần) ra quyết định cho lượt tiếp theo.

        note_applied cho biết voice agent đã nói ít nhất một lượt sau chỉ thị ẩn gần nhất hay chưa.
        """
        concept_id = session.current_concept_id
        concept = doc.concept(concept_id)
        history = [(r.question, r.answer) for r in session.evaluations if r.concept_id == concept_id]
        evaluation = await evaluate_answer(doc, concept, question, answer, history[-HISTORY_PER_CONCEPT:])

        progress = session.progress[concept_id]
        director.update_progress(progress, evaluation, hint_given=session.last_action == "hint")
        if progress.status not in {"pending", "in_progress"}:
            # Chủ đề đã đóng nhưng voice agent chưa kịp chuyển ý nên vẫn nhận thêm bằng chứng.
            progress.status = director.final_status(progress)

        directive: Directive | None = None
        if session.pending_concept_id:
            if note_applied:
                director.switch_concept(session, session.pending_concept_id)
                session.pending_concept_id = None
        elif not session.wrap_up_requested:
            directive = director.decide(session, doc, evaluation, director.Limits.from_settings())
            director.apply_directive(session, directive, defer_switch=defer_switch)

        session.evaluations.append(
            EvaluationRecord(
                concept_id=concept_id, question=question, answer=answer,
                evaluation=evaluation, directive=directive,
            )
        )
        return evaluation, directive

    async def answer_text(self, session_id: str, doc: DocumentRecord, answer: str) -> tuple[SessionRecord, str]:
        async with self.lock(session_id):
            current = self._load(session_id)
            if current.status == "finished":
                raise SessionFinished(session_id)
            # Làm trên bản sao để nếu gọi LLM lỗi thì phiên không bị ghi dở dang.
            session = current.model_copy(deep=True)
            question = session.last_question
            self.record_turn(session, "learner", answer)
            _, directive = await self.process_answer(session, doc, question, answer, defer_switch=False)
            if directive is None:
                directive = Directive(action="wrap_up", reason="Phiên đã được yêu cầu kết thúc")
            reply = await generate_utterance(session, doc, directive)
            self.record_turn(session, "interviewer", reply)
            if directive.action == "wrap_up":
                self.finish(session)
            self.store.save_session(session)
            return session, reply

    # -- Kết thúc và báo cáo ---------------------------------------------------

    def finish(self, session: SessionRecord) -> None:
        if session.status == "finished":
            return
        session.status = "finished"
        session.finished_at = utcnow()
        for progress in session.progress.values():
            if progress.status == "in_progress":
                progress.status = director.final_status(progress)

    async def build_report(self, session_id: str, doc: DocumentRecord) -> Report:
        for _ in range(VOICE_DRAIN_TIMEOUT_S * 2):
            if session_id not in self.active_voice:
                break
            await asyncio.sleep(0.5)
        async with self.lock(session_id):
            session = self._load(session_id).model_copy(deep=True)
            self.finish(session)
            session.report = await generate_report(session, doc)
            self.store.save_session(session)
            return session.report

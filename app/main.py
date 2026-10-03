import asyncio
import logging
from contextlib import asynccontextmanager
from typing import Literal

from fastapi import FastAPI, File, HTTPException, Request, UploadFile, WebSocket
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .config import settings
from .ingest import SUPPORTED_EXTENSIONS, UnsupportedFile, chunk_blocks, parse_document
from .interview.engine import InterviewEngine, SessionFinished, SessionNotFound
from .knowledge import build_knowledge_map
from .llm import LLMError, LLMNotConfigured
from .schemas import DocumentRecord, Report, SessionRecord
from .storage import new_id, store
from .voice import VoiceBridge

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(_: FastAPI):
    if settings.gemini_api_key:
        log.info(
            "GEMINI_API_KEY đã có. Não=%s, nhanh=%s, live=%s",
            settings.brain_model,
            settings.fast_model,
            settings.live_model,
        )
    else:
        log.warning("Chưa có GEMINI_API_KEY. Hãy điền key vào file .env rồi chạy lại .\\.venv\\Scripts\\python.exe -m app")
    yield


app = FastAPI(title="AI Interviewer", lifespan=lifespan)
engine = InterviewEngine(store)


@app.exception_handler(LLMNotConfigured)
async def _llm_not_configured(_: Request, exc: LLMNotConfigured) -> JSONResponse:
    return JSONResponse(status_code=503, content={"detail": str(exc)})


@app.exception_handler(LLMError)
async def _llm_error(_: Request, exc: LLMError) -> JSONResponse:
    log.warning("LLM error: %s", exc)
    return JSONResponse(status_code=502, content={"detail": str(exc)})


class SessionCreate(BaseModel):
    document_id: str
    learner_name: str = Field(default="bạn", max_length=60)
    mode: Literal["text", "voice"] = "voice"


class AnswerIn(BaseModel):
    text: str = Field(min_length=1, max_length=4000)


def _document_or_404(doc_id: str) -> DocumentRecord:
    doc = store.get_document(doc_id)
    if doc is None:
        raise HTTPException(404, "Không tìm thấy tài liệu")
    return doc


def _session_or_404(session_id: str) -> SessionRecord:
    session = store.get_session(session_id)
    if session is None:
        raise HTTPException(404, "Không tìm thấy phiên phỏng vấn")
    return session


def document_summary(doc: DocumentRecord) -> dict:
    km = doc.knowledge_map
    return {
        "id": doc.id,
        "filename": doc.filename,
        "created_at": doc.created_at.isoformat(),
        "title": km.title,
        "summary": km.summary,
        "truncated": doc.truncated,
        "chunk_count": len(doc.chunks),
        "concepts": [
            {"id": c.id, "name": c.name, "summary": c.summary, "importance": c.importance, "question_count": len(c.questions)}
            for c in km.concepts
        ],
    }


def session_public(session: SessionRecord, doc: DocumentRecord) -> dict:
    """Thông tin phiên an toàn để hiển thị cho người học (không chứa kết quả chấm)."""
    return {
        "id": session.id,
        "document_id": session.document_id,
        "document_title": doc.knowledge_map.title,
        "learner_name": session.learner_name,
        "mode": session.mode,
        "status": session.status,
        "created_at": session.created_at.isoformat(),
        "time_limit_seconds": settings.interview_minutes * 60,
        "turns": [{"role": t.role, "text": t.text, "at": t.at.isoformat()} for t in session.turns],
        "has_report": session.report is not None,
    }


@app.get("/api/health")
def health() -> dict:
    return {
        "ok": True,
        "llm_configured": bool(settings.gemini_api_key),
        "models": {"brain": settings.brain_model, "fast": settings.fast_model, "live": settings.live_model},
        "interview_minutes": settings.interview_minutes,
    }


@app.post("/api/documents")
async def upload_document(file: UploadFile = File(...)) -> dict:
    filename = file.filename or "tai-lieu.txt"
    if not any(filename.lower().endswith(ext) for ext in SUPPORTED_EXTENSIONS):
        raise HTTPException(400, "Chỉ hỗ trợ file PDF, DOCX, TXT hoặc MD")
    data = await file.read()
    if len(data) > settings.max_upload_mb * 1024 * 1024:
        raise HTTPException(413, f"File lớn hơn {settings.max_upload_mb} MB")
    try:
        blocks = await asyncio.to_thread(parse_document, filename, data)
    except UnsupportedFile as exc:
        raise HTTPException(400, str(exc)) from exc
    except Exception as exc:
        log.exception("Không đọc được file %s", filename)
        raise HTTPException(400, "Không đọc được file. File có thể bị hỏng hoặc được bảo vệ bằng mật khẩu.") from exc

    chunks = chunk_blocks(blocks)
    if not chunks:
        raise HTTPException(
            400, "Không tìm thấy chữ trong tài liệu. Nếu là PDF scan từ ảnh, hãy chạy OCR trước khi tải lên."
        )
    try:
        knowledge_map, truncated = await build_knowledge_map(filename, chunks)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc

    doc = DocumentRecord(
        id=new_id(),
        filename=filename,
        char_count=sum(len(c.text) for c in chunks),
        truncated=truncated,
        chunks=chunks,
        knowledge_map=knowledge_map,
    )
    store.save_document(doc)
    return document_summary(doc)


@app.get("/api/documents")
def list_documents() -> list[dict]:
    return [document_summary(doc) for doc in store.list_documents()]


@app.get("/api/documents/{doc_id}")
def get_document(doc_id: str) -> dict:
    doc = _document_or_404(doc_id)
    return {**document_summary(doc), "knowledge_map": doc.knowledge_map.model_dump()}


@app.post("/api/sessions")
async def create_session(body: SessionCreate) -> dict:
    doc = _document_or_404(body.document_id)
    learner_name = body.learner_name.strip() or "bạn"
    if body.mode == "text":
        session, message = await engine.start_text_session(doc, learner_name)
        return {"session": session_public(session, doc), "message": message}
    session = engine.start_voice_session(doc, learner_name)
    return {"session": session_public(session, doc), "message": None}


@app.get("/api/sessions/{session_id}")
def get_session(session_id: str) -> dict:
    session = _session_or_404(session_id)
    return session_public(session, _document_or_404(session.document_id))


@app.post("/api/sessions/{session_id}/messages")
async def post_message(session_id: str, body: AnswerIn) -> dict:
    session = _session_or_404(session_id)
    if session.mode != "text":
        raise HTTPException(409, "Phiên này dùng chế độ giọng nói")
    doc = _document_or_404(session.document_id)
    try:
        session, reply = await engine.answer_text(session_id, doc, body.text.strip())
    except SessionFinished as exc:
        raise HTTPException(409, "Buổi phỏng vấn đã kết thúc") from exc
    except SessionNotFound as exc:
        raise HTTPException(404, "Không tìm thấy phiên phỏng vấn") from exc
    return {"message": reply, "finished": session.status == "finished"}


@app.get("/api/sessions/{session_id}/insights")
def get_insights(session_id: str) -> dict:
    session = _session_or_404(session_id)
    return engine.insights(session, _document_or_404(session.document_id))


@app.post("/api/sessions/{session_id}/finish")
async def finish_session(session_id: str) -> Report:
    session = _session_or_404(session_id)
    if session.report is not None:
        return session.report
    return await engine.build_report(session_id, _document_or_404(session.document_id))


@app.get("/api/sessions/{session_id}/report")
def get_report(session_id: str) -> Report:
    session = _session_or_404(session_id)
    if session.report is None:
        raise HTTPException(404, "Phiên này chưa có báo cáo")
    return session.report


@app.websocket("/api/sessions/{session_id}/voice")
async def voice_socket(websocket: WebSocket, session_id: str) -> None:
    session = store.get_session(session_id)
    doc = store.get_document(session.document_id) if session else None
    if session is None or doc is None or session.mode != "voice":
        await websocket.close(code=4404)
        return
    if session.status != "active" or session_id in engine.active_voice:
        await websocket.close(code=4409)
        return
    await websocket.accept()
    await VoiceBridge(websocket, engine, session, doc).run()


app.mount("/", StaticFiles(directory=settings.web_dir, html=True), name="web")

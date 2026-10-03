import os
import re
import uuid
from pathlib import Path

from .config import settings
from .schemas import DocumentRecord, SessionRecord

_ID_PATTERN = re.compile(r"[a-f0-9]{12}")


def new_id() -> str:
    return uuid.uuid4().hex[:12]


def is_valid_id(value: str) -> bool:
    return bool(_ID_PATTERN.fullmatch(value))


def _write_atomic(path: Path, content: str) -> None:
    tmp = path.with_suffix(".tmp")
    tmp.write_text(content, encoding="utf-8")
    os.replace(tmp, path)


class JsonStore:
    """Lưu tài liệu và phiên phỏng vấn dưới dạng file JSON, có cache trong bộ nhớ."""

    def __init__(self, root: Path):
        self.docs_dir = root / "documents"
        self.sessions_dir = root / "sessions"
        self.docs_dir.mkdir(parents=True, exist_ok=True)
        self.sessions_dir.mkdir(parents=True, exist_ok=True)
        self._docs: dict[str, DocumentRecord] = {}
        self._sessions: dict[str, SessionRecord] = {}

    def save_document(self, doc: DocumentRecord) -> None:
        self._docs[doc.id] = doc
        _write_atomic(self.docs_dir / f"{doc.id}.json", doc.model_dump_json(indent=2))

    def get_document(self, doc_id: str) -> DocumentRecord | None:
        if not is_valid_id(doc_id):
            return None
        if doc_id not in self._docs:
            path = self.docs_dir / f"{doc_id}.json"
            if not path.exists():
                return None
            self._docs[doc_id] = DocumentRecord.model_validate_json(path.read_text(encoding="utf-8"))
        return self._docs[doc_id]

    def list_documents(self) -> list[DocumentRecord]:
        docs = [self.get_document(p.stem) for p in self.docs_dir.glob("*.json")]
        return sorted((d for d in docs if d), key=lambda d: d.created_at, reverse=True)

    def save_session(self, session: SessionRecord) -> None:
        self._sessions[session.id] = session
        _write_atomic(self.sessions_dir / f"{session.id}.json", session.model_dump_json(indent=2))

    def get_session(self, session_id: str) -> SessionRecord | None:
        if not is_valid_id(session_id):
            return None
        if session_id not in self._sessions:
            path = self.sessions_dir / f"{session_id}.json"
            if not path.exists():
                return None
            self._sessions[session_id] = SessionRecord.model_validate_json(path.read_text(encoding="utf-8"))
        return self._sessions[session_id]


store = JsonStore(settings.data_dir)

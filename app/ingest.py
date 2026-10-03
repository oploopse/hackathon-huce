import io
import re
import unicodedata
from dataclasses import dataclass
from pathlib import PurePath

import docx
import pymupdf
from docx.table import Table
from docx.text.paragraph import Paragraph

from .schemas import Chunk

SUPPORTED_EXTENSIONS = {".pdf", ".docx", ".txt", ".md"}

_SENTENCE_END = re.compile(r"(?<=[.!?…;:])\s+")


class UnsupportedFile(ValueError):
    pass


@dataclass
class Block:
    page: int | None
    text: str


def normalize_text(text: str) -> str:
    # PDF tiếng Việt hay chứa dấu ở dạng tổ hợp (NFD), cần chuẩn hóa để so khớp và hiển thị đúng.
    text = unicodedata.normalize("NFC", text)
    text = text.replace("\u00ad", "")
    text = re.sub(r"-\n(?=\w)", "", text)
    text = re.sub(r"\s*\n\s*", " ", text)
    text = re.sub(r"[ \t\u00a0]+", " ", text)
    return text.strip()


def parse_document(filename: str, data: bytes) -> list[Block]:
    ext = PurePath(filename).suffix.lower()
    if ext == ".pdf":
        return _parse_pdf(data)
    if ext == ".docx":
        return _parse_docx(data)
    if ext in {".txt", ".md"}:
        return _parse_text(data)
    raise UnsupportedFile(f"Chưa hỗ trợ định dạng {ext or 'không rõ'}. Hãy dùng PDF, DOCX, TXT hoặc MD.")


def _parse_pdf(data: bytes) -> list[Block]:
    blocks: list[Block] = []
    with pymupdf.open(stream=data, filetype="pdf") as pdf:
        for page_number, page in enumerate(pdf, start=1):
            # Mỗi block là tuple (x0, y0, x1, y1, text, block_no, block_type); block_type 1 là ảnh.
            for block in page.get_text("blocks", sort=True):
                text, block_type = block[4], block[6]
                if block_type != 0:
                    continue
                cleaned = normalize_text(text)
                if cleaned:
                    blocks.append(Block(page_number, cleaned))
    return blocks


def _parse_docx(data: bytes) -> list[Block]:
    document = docx.Document(io.BytesIO(data))
    blocks: list[Block] = []
    for item in document.iter_inner_content():
        if isinstance(item, Paragraph):
            cleaned = normalize_text(item.text)
            if cleaned:
                blocks.append(Block(None, cleaned))
        elif isinstance(item, Table):
            for row in item.rows:
                cells = [normalize_text(cell.text) for cell in row.cells]
                cells = list(dict.fromkeys(c for c in cells if c))
                if cells:
                    blocks.append(Block(None, " | ".join(cells)))
    return blocks


def _decode_text(data: bytes) -> str:
    if data.startswith((b"\xff\xfe", b"\xfe\xff")):
        return data.decode("utf-16")
    for encoding in ("utf-8-sig", "cp1258"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    return data.decode("latin-1")


def _parse_text(data: bytes) -> list[Block]:
    text = _decode_text(data).replace("\r\n", "\n")
    paragraphs = re.split(r"\n\s*\n", text)
    return [Block(None, cleaned) for p in paragraphs if (cleaned := normalize_text(p))]


def _split_long(text: str, max_chars: int) -> list[str]:
    if len(text) <= max_chars:
        return [text]
    pieces: list[str] = []
    current = ""
    for sentence in _SENTENCE_END.split(text):
        while len(sentence) > max_chars:
            pieces.extend([current] if current else [])
            current = ""
            pieces.append(sentence[:max_chars])
            sentence = sentence[max_chars:]
        if current and len(current) + 1 + len(sentence) > max_chars:
            pieces.append(current)
            current = sentence
        else:
            current = f"{current} {sentence}".strip()
    if current:
        pieces.append(current)
    return pieces


def chunk_blocks(blocks: list[Block], max_chars: int = 1200) -> list[Chunk]:
    chunks: list[Chunk] = []
    buffer: list[str] = []
    buffer_len = 0
    buffer_page: int | None = None

    def flush() -> None:
        nonlocal buffer, buffer_len, buffer_page
        if buffer:
            chunks.append(Chunk(id=f"ch{len(chunks) + 1}", page=buffer_page, text="\n".join(buffer)))
        buffer, buffer_len, buffer_page = [], 0, None

    for block in blocks:
        for piece in _split_long(block.text, max_chars):
            if buffer and (buffer_len + len(piece) + 1 > max_chars or block.page != buffer_page):
                flush()
            if not buffer:
                buffer_page = block.page
            buffer.append(piece)
            buffer_len += len(piece) + 1
    flush()
    return chunks


def select_chunks(chunks: list[Chunk], max_chars: int) -> tuple[list[Chunk], bool]:
    """Giới hạn lượng văn bản gửi cho LLM; trả về (các chunk được chọn, có bị cắt bớt không)."""
    selected: list[Chunk] = []
    total = 0
    for chunk in chunks:
        if total + len(chunk.text) > max_chars and selected:
            return selected, True
        selected.append(chunk)
        total += len(chunk.text)
    return selected, False

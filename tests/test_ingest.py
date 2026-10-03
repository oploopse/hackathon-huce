import unicodedata

import pytest

from app.ingest import Block, UnsupportedFile, chunk_blocks, normalize_text, parse_document, select_chunks
from app.schemas import Chunk


def test_normalize_text_converts_vietnamese_to_nfc_and_joins_lines():
    decomposed = unicodedata.normalize("NFD", "Học sinh\ncần   hiểu")
    assert normalize_text(decomposed) == "Học sinh cần hiểu"
    assert unicodedata.is_normalized("NFC", normalize_text(decomposed))


def test_normalize_text_rejoins_hyphenated_words():
    assert normalize_text("infor-\nmation") == "information"


def test_parse_text_splits_paragraphs():
    blocks = parse_document("note.txt", "Đoạn một\ncòn tiếp.\n\nĐoạn hai.".encode("utf-8"))
    assert [b.text for b in blocks] == ["Đoạn một còn tiếp.", "Đoạn hai."]


def test_parse_rejects_unknown_extension():
    with pytest.raises(UnsupportedFile):
        parse_document("slides.pptx", b"data")


def test_chunks_respect_page_boundaries_and_size():
    blocks = [Block(1, "a" * 500), Block(1, "b" * 500), Block(1, "c" * 500), Block(2, "d" * 100)]
    chunks = chunk_blocks(blocks, max_chars=1200)
    assert [c.id for c in chunks] == ["ch1", "ch2", "ch3"]
    assert [c.page for c in chunks] == [1, 1, 2]
    assert all(len(c.text) <= 1200 for c in chunks)


def test_long_paragraph_is_split_by_sentences():
    text = " ".join(f"Câu số {i} khá dài để kiểm tra việc chia nhỏ." for i in range(60))
    chunks = chunk_blocks([Block(None, text)], max_chars=300)
    assert len(chunks) > 1
    assert all(len(c.text) <= 300 for c in chunks)
    assert " ".join(c.text for c in chunks).replace("\n", " ").count("Câu số") == 60


def test_select_chunks_marks_truncation():
    chunks = [Chunk(id=f"ch{i}", text="x" * 100) for i in range(5)]
    selected, truncated = select_chunks(chunks, max_chars=250)
    assert [c.id for c in selected] == ["ch0", "ch4"]
    assert truncated
    assert select_chunks(chunks, max_chars=10_000) == (chunks, False)

"""Tuỳ chọn ở màn Thiết lập (số câu, thời gian, phạm vi trang) và các tiện ích giữ ngôn ngữ cho giọng nói."""

from app.interview import director
from app.interview.director import Limits
from app.prompts import document_terms, looks_foreign
from app.schemas import Chunk, EvaluationRecord

from .factories import make_concept, make_doc, make_eval, make_session


def test_question_limit_wraps_up_after_enough_answers():
    doc = make_doc(make_concept("c1"), make_concept("c2"))
    session = make_session(doc)
    limits = Limits(
        interview_minutes=15, max_concepts=6, max_answers_per_concept=4, max_hints_per_concept=1, question_limit=2
    )
    evaluation = make_eval(correctness=3, completeness=1, bloom_level=2)
    assert director.decide(session, doc, evaluation, limits).action == "probe_deeper"

    session.evaluations.append(EvaluationRecord(concept_id="c1", question="q", answer="a", evaluation=evaluation))
    assert director.decide(session, doc, evaluation, limits).action == "wrap_up"
    # Lượt chỉ hỏi lại câu hỏi không tính là một câu trả lời.
    clarify = make_eval(intent="clarification_request", correctness=0, completeness=0, reasoning=0, bloom_level=0)
    assert director.decide(session, doc, clarify, limits).action == "clarify"


def test_page_range_keeps_only_concepts_on_those_pages():
    first, second = make_concept("c1"), make_concept("c2")
    second.source_chunks = ["ch2"]
    doc = make_doc(first, second)
    doc.chunks = [Chunk(id="ch1", page=1, text="Một"), Chunk(id="ch2", page=7, text="Bảy")]

    assert [c.id for c in director.concepts_in_pages(doc, 5, 9)] == ["c2"]
    assert [c.id for c in director.concepts_in_pages(doc, None, None)] == ["c1", "c2"]
    assert director.concepts_in_pages(doc, 20, 30) == []


def test_session_options_are_applied(client, document):
    response = client.post(
        "/api/sessions",
        json={
            "document_id": document["id"], "learner_name": "Lan", "mode": "voice",
            "question_count": 6, "duration_minutes": 5,
        },
    )
    assert response.status_code == 200, response.text
    session = response.json()["session"]
    assert session["time_limit_seconds"] == 300
    assert session["question_limit"] == 6

    bad = client.post(
        "/api/sessions",
        json={"document_id": document["id"], "mode": "voice", "page_from": 5, "page_to": 2},
    )
    assert bad.status_code == 422
    assert client.post(
        "/api/sessions", json={"document_id": document["id"], "mode": "voice", "question_count": 20}
    ).status_code == 422


def test_looks_foreign_ignores_vietnamese_with_terms():
    assert looks_foreign("TCP uses a three way handshake before sending data")
    assert not looks_foreign("TCP dùng bắt tay ba bước trước khi gửi dữ liệu")
    assert not looks_foreign("UDP")


def test_document_terms_collects_technical_terms():
    concept = make_concept("c1")
    doc = make_doc(concept)
    doc.chunks = [Chunk(id="ch1", page=1, text="Dồn kênh (multiplexing) ở tầng giao vận dùng TCP và UDP, có checksum.")]
    terms = document_terms(doc)
    assert "Concept c1" in terms
    for term in ("multiplexing", "TCP", "UDP"):
        assert term in terms

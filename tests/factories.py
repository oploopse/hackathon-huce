from app.schemas import (
    Chunk,
    Concept,
    ConceptProgress,
    DocumentRecord,
    KeyPoint,
    KnowledgeMap,
    Question,
    SessionRecord,
    TurnEvaluation,
)


def make_concept(concept_id: str, importance: int = 2, prerequisites: list[str] | None = None) -> Concept:
    return Concept(
        id=concept_id,
        name=f"Concept {concept_id}",
        summary="Tóm tắt",
        importance=importance,
        prerequisites=prerequisites or [],
        source_chunks=["ch1"],
        key_points=[KeyPoint(id=f"{concept_id}.k1", text="Ý 1"), KeyPoint(id=f"{concept_id}.k2", text="Ý 2")],
        misconceptions=["Hiểu lầm phổ biến"],
        questions=[
            Question(bloom_level=2, text=f"{concept_id} là gì?"),
            Question(bloom_level=3, text=f"Áp dụng {concept_id} thế nào?"),
            Question(bloom_level=4, text=f"Vì sao {concept_id} quan trọng?"),
        ],
    )


def make_doc(*concepts: Concept) -> DocumentRecord:
    return DocumentRecord(
        id="aaaaaaaaaaaa",
        filename="bai-giang.txt",
        char_count=100,
        chunks=[Chunk(id="ch1", page=1, text="Nội dung")],
        knowledge_map=KnowledgeMap(title="Bài giảng", summary="Tóm tắt", concepts=list(concepts)),
    )


def make_session(doc: DocumentRecord) -> SessionRecord:
    order = [c.id for c in doc.knowledge_map.concepts]
    session = SessionRecord(
        id="bbbbbbbbbbbb",
        document_id=doc.id,
        learner_name="Lan",
        mode="text",
        concept_order=order,
        progress={cid: ConceptProgress(concept_id=cid) for cid in order},
        last_question="Câu hỏi hiện tại?",
    )
    session.current_concept_id = order[0]
    session.progress[order[0]].status = "in_progress"
    return session


def make_eval(**overrides) -> TurnEvaluation:
    values = dict(
        intent="answer",
        correctness=3,
        completeness=3,
        reasoning=3,
        bloom_level=2,
        covered_key_points=[],
        missing_key_points=[],
        misconceptions=[],
        rote_signal="low",
        confidence_signal="medium",
        evidence_quote="trích dẫn",
        summary="Nhận xét",
        suggested_follow_up="Bạn có thể cho một ví dụ không?",
    )
    values.update(overrides)
    return TurnEvaluation(**values)

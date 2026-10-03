from app.knowledge import normalize_knowledge_map
from app.schemas import Concept, KeyPoint, KnowledgeMap, Question


def raw_concept(concept_id, prerequisites, questions, chunks=("ch1", "ch99")):
    return Concept(
        id=concept_id,
        name=f"Tên {concept_id}",
        summary="Tóm tắt",
        importance=7,
        prerequisites=prerequisites,
        source_chunks=list(chunks),
        key_points=[KeyPoint(id="x", text="Ý A"), KeyPoint(id="x", text="  ")],
        misconceptions=["Sai 1", ""],
        questions=questions,
    )


def test_normalize_remaps_ids_and_filters_invalid_references():
    raw = KnowledgeMap(
        title="  ",
        summary="Tóm tắt",
        concepts=[
            raw_concept("A", [], [Question(bloom_level=9, text="Câu khó"), Question(bloom_level=2, text="Câu dễ")]),
            raw_concept("B", ["A", "B", "Z"], [Question(bloom_level=3, text="Câu vận dụng")]),
        ],
    )
    km = normalize_knowledge_map(raw, valid_chunk_ids={"ch1"})

    assert km.title == "Tài liệu"
    first, second = km.concepts
    assert (first.id, second.id) == ("c1", "c2")
    assert second.prerequisites == ["c1"]
    assert first.source_chunks == ["ch1"]
    assert first.importance == 3
    assert [kp.id for kp in first.key_points] == ["c1.k1"]
    assert first.misconceptions == ["Sai 1"]
    assert [(q.bloom_level, q.text) for q in first.questions] == [(2, "Câu dễ"), (6, "Câu khó")]


def test_normalize_adds_fallback_question():
    raw = KnowledgeMap(title="T", summary="S", concepts=[raw_concept("A", [], [])])
    km = normalize_knowledge_map(raw, valid_chunk_ids=set())
    assert len(km.concepts[0].questions) == 1
    assert km.concepts[0].questions[0].bloom_level == 2

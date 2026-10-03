from .config import settings
from .ingest import select_chunks
from .llm import generate_json
from .prompts import KNOWLEDGE_MAP_PROMPT, KNOWLEDGE_MAP_SYSTEM
from .schemas import Chunk, Concept, KeyPoint, KnowledgeMap, Question


def concept_range(total_chars: int) -> tuple[int, int]:
    if total_chars < 6_000:
        return 3, 5
    if total_chars < 30_000:
        return 4, 8
    return 6, 10


def format_document(chunks: list[Chunk]) -> str:
    return "\n\n".join(
        f"[{c.id}]" + (f" (trang {c.page})" if c.page else "") + f" {c.text}" for c in chunks
    )


async def build_knowledge_map(filename: str, chunks: list[Chunk]) -> tuple[KnowledgeMap, bool]:
    selected, truncated = select_chunks(chunks, settings.max_document_chars)
    min_concepts, max_concepts = concept_range(sum(len(c.text) for c in selected))
    prompt = KNOWLEDGE_MAP_PROMPT.format(
        min_concepts=min_concepts,
        max_concepts=max_concepts,
        filename=filename,
        document=format_document(selected),
    )
    raw = await generate_json(
        settings.brain_model, KNOWLEDGE_MAP_SYSTEM, prompt, KnowledgeMap, thinking_level="medium"
    )
    return normalize_knowledge_map(raw, {c.id for c in chunks}), truncated


def normalize_knowledge_map(raw: KnowledgeMap, valid_chunk_ids: set[str]) -> KnowledgeMap:
    """Đánh lại mã concept/ý chính cho nhất quán và loại bỏ tham chiếu không hợp lệ từ LLM."""
    id_map: dict[str, str] = {}
    concepts: list[Concept] = []
    for item in raw.concepts:
        name = item.name.strip()
        if not name:
            continue
        concept_id = f"c{len(concepts) + 1}"
        id_map.setdefault(item.id.strip(), concept_id)

        key_point_texts = [kp.text.strip() for kp in item.key_points if kp.text.strip()]
        if not key_point_texts and item.summary.strip():
            key_point_texts = [item.summary.strip()]
        key_points = [
            KeyPoint(id=f"{concept_id}.k{i}", text=text) for i, text in enumerate(key_point_texts[:5], start=1)
        ]

        questions = sorted(
            (
                Question(bloom_level=min(max(q.bloom_level, 1), 6), text=q.text.strip())
                for q in item.questions
                if q.text.strip()
            ),
            key=lambda q: q.bloom_level,
        )
        if not questions:
            questions = [Question(bloom_level=2, text=f"Bạn hãy giải thích {name} bằng lời của mình nhé?")]

        concepts.append(
            Concept(
                id=concept_id,
                name=name,
                summary=item.summary.strip(),
                importance=min(max(item.importance, 1), 3),
                prerequisites=[p.strip() for p in item.prerequisites],
                source_chunks=[c for c in dict.fromkeys(item.source_chunks) if c in valid_chunk_ids][:6],
                key_points=key_points,
                misconceptions=[m.strip() for m in item.misconceptions if m.strip()][:3],
                questions=questions[:4],
            )
        )

    for concept in concepts:
        remapped = (id_map.get(p) for p in concept.prerequisites)
        concept.prerequisites = [p for p in dict.fromkeys(remapped) if p and p != concept.id]

    if not concepts:
        raise ValueError("Không trích xuất được concept nào từ tài liệu.")
    return KnowledgeMap(
        title=raw.title.strip() or "Tài liệu", summary=raw.summary.strip(), concepts=concepts
    )

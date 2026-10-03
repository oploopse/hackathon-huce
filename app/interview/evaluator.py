from ..config import settings
from ..llm import generate_json
from ..prompts import EVALUATOR_SYSTEM, render_evaluation_prompt
from ..schemas import Concept, DocumentRecord, TurnEvaluation

MAX_EXCERPTS = 6


def _clamp(value: int, upper: int) -> int:
    return min(max(int(value), 0), upper)


def _excerpts(doc: DocumentRecord, concept: Concept) -> list[str]:
    by_id = doc.chunks_by_id()
    excerpts = []
    for chunk_id in concept.source_chunks[:MAX_EXCERPTS]:
        chunk = by_id.get(chunk_id)
        if chunk:
            page = f" (trang {chunk.page})" if chunk.page else ""
            excerpts.append(f"[{chunk.id}]{page} {chunk.text}")
    return excerpts


def sanitize_evaluation(evaluation: TurnEvaluation, concept: Concept) -> TurnEvaluation:
    valid_ids = {kp.id for kp in concept.key_points}
    covered = [k for k in dict.fromkeys(evaluation.covered_key_points) if k in valid_ids]
    missing = [k for k in dict.fromkeys(evaluation.missing_key_points) if k in valid_ids and k not in covered]
    return evaluation.model_copy(
        update={
            "correctness": _clamp(evaluation.correctness, 4),
            "completeness": _clamp(evaluation.completeness, 4),
            "reasoning": _clamp(evaluation.reasoning, 4),
            "bloom_level": _clamp(evaluation.bloom_level, 6),
            "covered_key_points": covered,
            "missing_key_points": missing,
            "misconceptions": [m.strip() for m in evaluation.misconceptions if m.strip()][:3],
        }
    )


async def evaluate_answer(
    doc: DocumentRecord,
    concept: Concept,
    question: str,
    answer: str,
    history: list[tuple[str, str]],
) -> TurnEvaluation:
    prompt = render_evaluation_prompt(concept, _excerpts(doc, concept), history, question, answer)
    evaluation = await generate_json(
        settings.brain_model, EVALUATOR_SYSTEM, prompt, TurnEvaluation, thinking_level="low"
    )
    return sanitize_evaluation(evaluation, concept)

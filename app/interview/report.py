from ..config import settings
from ..llm import generate_json
from ..prompts import REPORT_SYSTEM, render_report_prompt
from ..schemas import ConceptReport, ConceptStatus, DocumentRecord, Level, Report, ReportNarrative, SessionRecord
from .director import final_status


def concept_level(status: ConceptStatus, score: int) -> Level:
    if status in {"pending", "unassessed"}:
        return "not_assessed"
    if status == "mastered":
        return "strong"
    if status == "gap":
        return "gap"
    return "good" if score >= 60 else "basic"


def overall_level(score: int) -> Level:
    if score >= 80:
        return "strong"
    if score >= 65:
        return "good"
    if score >= 45:
        return "basic"
    return "gap"


async def generate_report(session: SessionRecord, doc: DocumentRecord) -> Report:
    chunks = doc.chunks_by_id()
    assessed = []
    for concept_id in session.concept_order:
        progress = session.progress[concept_id]
        if progress.status == "in_progress":
            progress.status = final_status(progress)
        if progress.status == "pending":
            continue
        concept = doc.concept(concept_id)
        pages = sorted({chunks[c].page for c in concept.source_chunks if c in chunks and chunks[c].page})
        assessed.append((concept, progress, round(progress.score * 100), pages))

    evaluated = [row for row in assessed if row[1].evidence_count > 0]
    if evaluated:
        total_weight = sum(concept.importance for concept, *_ in evaluated)
        overall = round(sum(score * concept.importance for concept, _, score, _ in evaluated) / total_weight)
    else:
        overall = 0

    narrative: ReportNarrative | None = None
    if evaluated:
        prompt = render_report_prompt(doc, session.learner_name, evaluated, session.evaluations)
        narrative = await generate_json(
            settings.brain_model, REPORT_SYSTEM, prompt, ReportNarrative, thinking_level="medium"
        )
    feedback = {f.concept_id: f for f in narrative.concept_feedback} if narrative else {}

    concept_reports = []
    for concept, progress, score, pages in assessed:
        fb = feedback.get(concept.id)
        evidence = [
            r.evaluation.evidence_quote
            for r in session.evaluations
            if r.concept_id == concept.id and r.evaluation.evidence_quote.strip()
        ][:2]
        concept_reports.append(
            ConceptReport(
                concept_id=concept.id,
                name=concept.name,
                importance=concept.importance,
                status=progress.status,
                level=concept_level(progress.status, score),
                score=score if progress.evidence_count else 0,
                max_bloom=progress.max_bloom,
                hints=progress.hints,
                strengths=fb.strengths if fb else [],
                gaps=fb.gaps if fb else [],
                misconceptions=progress.misconceptions,
                advice=fb.advice if fb else "",
                evidence=evidence,
                review_pages=pages,
            )
        )

    if narrative is None:
        no_data = "Buổi phỏng vấn chưa có đủ câu trả lời để đánh giá."
        return Report(
            overall_score=0,
            overall_level="not_assessed",
            summary_for_learner=no_data,
            summary_for_teacher=no_data,
            concepts=concept_reports,
            study_plan=[],
            teacher_notes=[],
        )
    return Report(
        overall_score=overall,
        overall_level=overall_level(overall),
        summary_for_learner=narrative.summary_for_learner,
        summary_for_teacher=narrative.summary_for_teacher,
        concepts=concept_reports,
        study_plan=narrative.study_plan,
        teacher_notes=narrative.teacher_notes,
    )

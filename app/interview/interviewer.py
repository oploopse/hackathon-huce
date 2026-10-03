from ..config import settings
from ..llm import generate_text
from ..prompts import interviewer_persona, render_text_turn_prompt
from ..schemas import Directive, DocumentRecord, SessionRecord

RECENT_TURNS = 8


async def generate_utterance(session: SessionRecord, doc: DocumentRecord, directive: Directive) -> str:
    """Sinh lời nói tiếp theo của người phỏng vấn ở chế độ văn bản."""
    concept = None if directive.action == "wrap_up" else doc.concept(directive.concept_id or session.current_concept_id)
    system = interviewer_persona(doc.knowledge_map.title, session.learner_name, voice=False)
    prompt = render_text_turn_prompt(concept, session.learner_name, session.turns[-RECENT_TURNS:], directive)
    return await generate_text(settings.fast_model, system, prompt, thinking_level="minimal")

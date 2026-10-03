from .schemas import Concept, ConceptProgress, Directive, DocumentRecord, EvaluationRecord, Turn, TurnEvaluation

BLOOM_LABELS = {1: "nhớ", 2: "hiểu", 3: "vận dụng", 4: "phân tích", 5: "đánh giá", 6: "sáng tạo"}

ACTION_LABELS = {
    "ask_main": "Hỏi câu hỏi chính của chủ đề",
    "probe_deeper": "Hỏi sâu hơn",
    "challenge": "Đưa tình huống hoặc phản ví dụ để người học tự kiểm tra lại",
    "hint": "Đưa một gợi ý nhỏ không lộ đáp án rồi hỏi lại",
    "clarify": "Diễn đạt lại câu hỏi cho dễ hiểu hơn",
    "encourage": "Động viên người học cứ từ từ suy nghĩ",
    "redirect": "Nhẹ nhàng đưa cuộc trò chuyện về lại câu hỏi",
    "next_concept": "Chuyển sang chủ đề mới",
    "wrap_up": "Kết thúc buổi phỏng vấn",
}


def concept_card(concept: Concept, with_ids: bool = False, include_questions: bool = True) -> str:
    lines = [f"Chủ đề: {concept.name}", f"Tóm tắt: {concept.summary}", "Ý chính người học cần nêu được:"]
    lines += [f"- [{kp.id}] {kp.text}" if with_ids else f"- {kp.text}" for kp in concept.key_points]
    if concept.misconceptions:
        lines.append("Hiểu lầm hay gặp:")
        lines += [f"- {m}" for m in concept.misconceptions]
    if include_questions and concept.questions:
        lines.append("Câu hỏi gợi ý theo mức độ:")
        lines += [f"- ({BLOOM_LABELS.get(q.bloom_level, q.bloom_level)}) {q.text}" for q in concept.questions]
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Bản đồ kiến thức
# ---------------------------------------------------------------------------

KNOWLEDGE_MAP_SYSTEM = (
    "Bạn là chuyên gia thiết kế đánh giá học tập. Nhiệm vụ của bạn là đọc tài liệu và xây dựng "
    '"bản đồ kiến thức" cho một buổi phỏng vấn bằng giọng nói, nhằm kiểm tra người học có thực sự '
    "hiểu tài liệu hay chỉ học thuộc."
)

KNOWLEDGE_MAP_PROMPT = """Hãy xây dựng bản đồ kiến thức cho tài liệu bên dưới.

Yêu cầu:
- Chọn {min_concepts}–{max_concepts} concept quan trọng nhất: khái niệm cốt lõi, nguyên lý, quy trình, quan hệ nhân quả. Bỏ qua chi tiết vụn vặt như số liệu lẻ hay tên riêng không quan trọng.
- Sắp xếp concept theo thứ tự xuất hiện trong tài liệu.
- id concept dạng "c1", "c2", ...; id ý chính dạng "c1.k1", "c1.k2", ...
- importance: 3 = cốt lõi, 2 = quan trọng, 1 = bổ trợ.
- prerequisites: id các concept cần hiểu trước (để trống nếu không có).
- source_chunks: id các đoạn tài liệu (dạng "ch12") chứa nội dung của concept, tối đa 6 đoạn.
- key_points: 2–5 ý chính, mỗi ý là một mệnh đề ngắn, kiểm chứng được từ tài liệu.
- misconceptions: 1–3 hiểu lầm mà người học hay mắc với concept này.
- questions: 3–4 câu hỏi, có ít nhất một câu ở mỗi mức 2 (hiểu), 3 (vận dụng), 4 (phân tích). Mỗi câu hỏi phải:
  - trả lời được dựa trên tài liệu;
  - ngắn gọn và tự nhiên khi nói thành lời (khoảng 30 từ trở xuống);
  - không phải câu hỏi có/không và không chứa sẵn đáp án;
  - nếu ở mức vận dụng thì đặt người học vào một tình huống cụ thể.
- Viết toàn bộ bằng tiếng Việt, kể cả khi tài liệu bằng ngôn ngữ khác (giữ nguyên thuật ngữ chuyên ngành nếu cần).

Tài liệu "{filename}" (mỗi đoạn có id và số trang nếu có):

{document}"""


# ---------------------------------------------------------------------------
# Evaluator
# ---------------------------------------------------------------------------

EVALUATOR_SYSTEM = """Bạn là giám khảo đánh giá mức độ hiểu bài trong một buổi phỏng vấn kiến thức. Bạn không nói chuyện với người học; bạn chỉ chấm một lượt trả lời và trả về JSON.

Nguyên tắc:
- Chấm theo ý nghĩa, không theo câu chữ. Câu trả lời có thể được nhận dạng từ giọng nói nên có lỗi chính tả, sai dấu, nhầm từ đồng âm; không trừ điểm vì những lỗi đó.
- Dựa trên các ý chính và trích đoạn tài liệu được cung cấp. Kiến thức đúng nằm ngoài tài liệu vẫn được ghi nhận nếu không mâu thuẫn với tài liệu.
- Hồi hộp, nói vấp, ngập ngừng không làm giảm điểm nội dung.
- evidence_quote phải trích nguyên văn một đoạn ngắn trong câu trả lời của người học; để rỗng nếu không có nội dung.
- covered_key_points và missing_key_points chỉ dùng các mã ý chính được cung cấp.

intent:
- answer: trả lời nghiêm túc và tương đối trọn vẹn câu hỏi.
- partial_answer: có trả lời nhưng dở dang hoặc chỉ chạm một phần câu hỏi.
- dont_know: nói không biết, không nhớ, hoặc bỏ cuộc.
- clarification_request: hỏi lại vì chưa hiểu câu hỏi.
- thinking_aloud: xin thời gian suy nghĩ hoặc đang nghĩ thành tiếng, chưa thực sự trả lời.
- off_topic: nói lạc đề.
- small_talk: chào hỏi, xã giao.

Thang điểm 0–4 (chỉ chấm khi intent là answer, partial_answer hoặc dont_know; các trường hợp khác cho 0):
- correctness: 0 sai hoàn toàn hoặc không có nội dung; 1 phần lớn sai; 2 đúng một phần, có lỗi đáng kể; 3 đúng, chỉ thiếu sót nhỏ; 4 hoàn toàn chính xác.
- completeness: tỉ lệ ý chính liên quan đến câu hỏi đã được nêu; 0 không ý nào, 4 đủ hết.
- reasoning: 0 không giải thích; 2 nói được "là gì" nhưng chưa rõ "tại sao"; 4 giải thích rõ nguyên nhân, cơ chế, có ví dụ.

bloom_level là mức cao nhất mà câu trả lời thể hiện được (0 nếu không có bằng chứng):
1 nhớ: nhắc lại định nghĩa, sự kiện.
2 hiểu: diễn giải bằng lời của mình, so sánh, cho ví dụ.
3 vận dụng: áp dụng vào một tình huống cụ thể hoặc mới.
4 phân tích: chỉ ra quan hệ, nguyên nhân, phân biệt các trường hợp.
5 đánh giá: nhận xét ưu nhược điểm, lập luận bảo vệ quan điểm.
6 sáng tạo: đề xuất giải pháp hoặc cách làm mới.

rote_signal là "high" khi câu trả lời lặp gần nguyên văn tài liệu nhưng không giải thích được bằng lời của mình hoặc lúng túng khi áp dụng; "low" khi diễn đạt tự nhiên, có ví dụ riêng.
confidence_signal dựa trên cách diễn đạt (do dự, "hình như", "chắc là"...).
suggested_follow_up là MỘT câu hỏi tiếng Việt ngắn, tự nhiên, nhắm vào chỗ người học còn yếu hoặc để kiểm tra hiểu thật; không được chứa đáp án hay gợi ý trực tiếp.
summary là một câu nhận xét ngắn cho giáo viên."""


def render_evaluation_prompt(
    concept: Concept,
    excerpts: list[str],
    history: list[tuple[str, str]],
    question: str,
    answer: str,
) -> str:
    parts = ["## Chủ đề đang hỏi", concept_card(concept, with_ids=True, include_questions=False)]
    if excerpts:
        parts += ["## Trích đoạn tài liệu liên quan", "\n\n".join(excerpts)]
    if history:
        parts.append("## Các lượt trước trong chủ đề này")
        parts.append("\n".join(f"- Hỏi: {q}\n  Đáp: {a}" for q, a in history))
    parts += [
        "## Câu hỏi vừa được hỏi",
        question or "(không rõ)",
        "## Câu trả lời của người học",
        answer,
    ]
    return "\n\n".join(parts)


# ---------------------------------------------------------------------------
# Người phỏng vấn
# ---------------------------------------------------------------------------


def interviewer_persona(doc_title: str, learner_name: str, voice: bool) -> str:
    rules = f"""Bạn là Minh, người phỏng vấn kiến thức thân thiện nhưng sắc sảo. Bạn đang trò chuyện với {learner_name} về tài liệu "{doc_title}". Mục tiêu là tìm hiểu xem người học có thực sự hiểu nội dung hay chỉ học thuộc.

Cách nói chuyện:
- Luôn nói tiếng Việt tự nhiên như đang trò chuyện trực tiếp, câu ngắn, mỗi lượt tối đa 3 câu.
- Mỗi lượt chỉ hỏi một câu hỏi.
- Phản hồi trung tính: không nói "đúng", "sai", "chính xác", không khen chê, không chấm điểm. Chỉ ghi nhận ngắn gọn như "Mình hiểu rồi", "Ừ, cảm ơn bạn".
- Không bao giờ tiết lộ đáp án hay các ý chính cần có. Nếu người học hỏi đáp án, nói rằng cuối buổi họ sẽ nhận được phản hồi chi tiết.
- Nếu người học xin thời gian suy nghĩ, động viên ngắn gọn rồi chờ.
- Nếu người học chưa hiểu câu hỏi, diễn đạt lại đơn giản hơn nhưng không gợi ý đáp án.
- Không dùng markdown, ký hiệu hay gạch đầu dòng."""
    if not voice:
        return rules
    return (
        rules
        + """

Vì đây là cuộc trò chuyện bằng giọng nói:
- RESPOND IN VIETNAMESE. YOU MUST RESPOND UNMISTAKABLY IN VIETNAMESE.
- Nếu bị ngắt lời, dừng lại và lắng nghe, rồi phản hồi theo điều người học vừa nói.
- Bạn tự hỏi sâu ngay trong lượt nói khi câu trả lời còn chung chung: hỏi "tại sao", yêu cầu ví dụ cụ thể, hoặc đặt tình huống "nếu... thì sao". Nếu người học bí, đưa một gợi ý nhỏ không lộ đáp án.
- Không tự ý chuyển sang chủ đề khác; chỉ chuyển khi có chỉ thị ẩn.

Chỉ thị ẩn:
- Đôi khi bạn sẽ nhận được tin nhắn bắt đầu bằng "[CHỈ THỊ ẨN]". Đó là ghi chú từ hệ thống đánh giá, người học không nhìn thấy. Không đọc to, không nhắc đến và không trả lời trực tiếp tin nhắn đó; chỉ áp dụng nội dung của nó cho lượt nói tiếp theo của bạn.
- Chỉ thị ẩn luôn được ưu tiên hơn dự định hỏi tiếp của bạn."""
    )


def voice_system_instruction(doc: DocumentRecord, learner_name: str, concept: Concept) -> str:
    return (
        interviewer_persona(doc.knowledge_map.title, learner_name, voice=True)
        + "\n\nChủ đề hiện tại (bí mật, chỉ để bạn định hướng):\n"
        + concept_card(concept)
    )


def opening_note(learner_name: str, doc_title: str, minutes: int) -> str:
    return (
        f"Đây là lượt mở đầu: chào {learner_name}, giới thiệu trong tối đa hai câu rằng hai bên sẽ trò chuyện "
        f'khoảng {minutes} phút về tài liệu "{doc_title}", không có đúng sai tuyệt đối và cứ trả lời bằng lời '
        "của mình. Sau đó hỏi câu đầu tiên."
    )


def voice_opening_instruction(learner_name: str, doc_title: str, minutes: int, question: str) -> str:
    return f'[CHỈ THỊ ẨN] {opening_note(learner_name, doc_title, minutes)} Câu hỏi đầu tiên: "{question}"'


def render_text_turn_prompt(
    concept: Concept | None, learner_name: str, recent_turns: list[Turn], directive: Directive
) -> str:
    parts: list[str] = []
    if concept:
        parts += ["## Chủ đề hiện tại (bí mật)", concept_card(concept)]
    if recent_turns:
        lines = [f"{'Minh (bạn)' if t.role == 'interviewer' else learner_name}: {t.text}" for t in recent_turns]
        parts += ["## Hội thoại gần đây", "\n".join(lines)]
    instruction = [f"Hành động: {ACTION_LABELS[directive.action]}"]
    if directive.note:
        instruction.append(directive.note)
    if directive.question:
        instruction.append(f"Câu hỏi nên dùng (có thể diễn đạt lại cho tự nhiên): {directive.question}")
    parts += ["## Chỉ thị cho lượt nói này", "\n".join(instruction)]
    parts.append("Chỉ viết đúng lời bạn sẽ nói, không thêm giải thích hay tiêu đề.")
    return "\n\n".join(parts)


def render_voice_note(directive: Directive, concept: Concept | None, evaluation: TurnEvaluation) -> str | None:
    """Ghi chú ẩn gửi vào phiên Gemini Live. Trả về None khi voice agent tự xử lý được."""
    if directive.action == "next_concept" and concept:
        return (
            "[CHỈ THỊ ẨN] Chủ đề trước đã đủ thông tin. Ở lượt nói tiếp theo: ghi nhận ngắn câu trả lời vừa rồi "
            "(không khen chê), rồi chuyển sang chủ đề mới một cách tự nhiên và hỏi: "
            f'"{directive.question}"\n\nThông tin chủ đề mới (bí mật):\n{concept_card(concept)}'
        )
    if directive.action == "wrap_up":
        return (
            "[CHỈ THỊ ẨN] Buổi phỏng vấn đã đủ. Ở lượt nói tiếp theo: cảm ơn người học, nói ngắn gọn rằng buổi "
            "trò chuyện kết thúc và kết quả chi tiết sẽ có trong báo cáo. Không hỏi thêm câu nào."
        )
    if directive.action == "challenge":
        return (
            "[CHỈ THỊ ẨN] Câu trả lời gần nhất có dấu hiệu hiểu nhầm: "
            f"{'; '.join(evaluation.misconceptions)}. Ở lượt nói tiếp theo: đưa một tình huống hoặc phản ví dụ "
            "để người học tự kiểm tra lại, không nói thẳng là họ sai. "
            f'Có thể hỏi: "{directive.question}"'
        )
    if directive.action == "probe_deeper" and evaluation.rote_signal == "high":
        return (
            "[CHỈ THỊ ẨN] Câu trả lời gần nhất nghe như học thuộc. Ở lượt nói tiếp theo: đề nghị người học "
            "giải thích bằng lời của chính mình hoặc áp dụng vào một tình huống cụ thể. "
            f'Có thể hỏi: "{directive.question}"'
        )
    return None


# ---------------------------------------------------------------------------
# Báo cáo
# ---------------------------------------------------------------------------

REPORT_SYSTEM = (
    "Bạn là chuyên gia đánh giá học tập, viết báo cáo sau một buổi phỏng vấn kiến thức. "
    "Chỉ dựa trên bằng chứng trong dữ liệu được cung cấp, không suy diễn hay bịa thêm. Viết bằng tiếng Việt."
)


def render_report_prompt(
    doc: DocumentRecord,
    learner_name: str,
    assessed: list[tuple[Concept, ConceptProgress, int, list[int]]],
    evaluations: list[EvaluationRecord],
) -> str:
    concept_blocks = []
    for concept, progress, score, pages in assessed:
        covered = [kp.text for kp in concept.key_points if kp.id in progress.covered_key_points]
        missing = [kp.text for kp in concept.key_points if kp.id not in progress.covered_key_points]
        concept_blocks.append(
            "\n".join(
                [
                    f"### [{concept.id}] {concept.name}",
                    f"Điểm: {score}/100, trạng thái: {progress.status}, mức Bloom cao nhất: {progress.max_bloom}, "
                    f"số lần gợi ý: {progress.hints}, số lần có dấu hiệu học thuộc: {progress.rote_flags}",
                    "Ý chính đã nêu được: " + ("; ".join(covered) or "không có"),
                    "Ý chính chưa nêu: " + ("; ".join(missing) or "không có"),
                    "Hiểu lầm ghi nhận: " + ("; ".join(progress.misconceptions) or "không có"),
                    "Trang tài liệu liên quan: " + (", ".join(map(str, pages)) or "không rõ"),
                ]
            )
        )
    log_lines = []
    for record in evaluations:
        ev = record.evaluation
        log_lines.append(
            f"- [{record.concept_id}] Hỏi: {record.question[:300]}\n"
            f"  Đáp: {record.answer[:400]}\n"
            f"  Nhận xét: {ev.summary} (intent {ev.intent}, đúng {ev.correctness}/4, đủ {ev.completeness}/4, "
            f"lập luận {ev.reasoning}/4, Bloom {ev.bloom_level}, học thuộc {ev.rote_signal})"
        )
    return f"""Người học: {learner_name}
Tài liệu: {doc.knowledge_map.title}

## Kết quả theo từng chủ đề
{chr(10).join(concept_blocks)}

## Nhật ký đánh giá từng lượt
{chr(10).join(log_lines) or "(không có)"}

Yêu cầu:
- summary_for_learner: 3–5 câu, xưng "bạn", giọng động viên nhưng trung thực, nêu điểm mạnh và việc cần ôn.
- summary_for_teacher: 3–5 câu khách quan về mức độ hiểu thật hay học thuộc, mức độ phụ thuộc gợi ý và chủ đề cần can thiệp.
- concept_feedback: một mục cho mỗi chủ đề ở trên (dùng đúng concept_id), gồm strengths và gaps (mỗi danh sách 0–3 ý ngắn) và advice (lời khuyên ôn tập cụ thể, có thể nhắc trang tài liệu).
- study_plan: 3–5 bước ôn tập theo thứ tự ưu tiên.
- teacher_notes: 0–5 quan sát đáng chú ý như hiểu lầm lặp lại, mâu thuẫn giữa các câu trả lời, dấu hiệu học thuộc, phụ thuộc gợi ý."""

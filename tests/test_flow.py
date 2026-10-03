"""Chạy trọn một buổi phỏng vấn văn bản qua API với LLM giả, không cần GEMINI_API_KEY."""

import pytest

import app.main as main


def test_full_text_interview(client, document):
    assert [c["id"] for c in document["concepts"]] == ["c1", "c2"]
    assert "knowledge_map" not in client.get(f"/api/documents/{document['id']}").json()

    created = client.post("/api/sessions", json={"document_id": document["id"], "learner_name": "Lan", "mode": "text"})
    assert created.status_code == 200, created.text
    session_id = created.json()["session"]["id"]
    assert created.json()["message"]

    first = client.post(f"/api/sessions/{session_id}/messages", json={"text": "Câu trả lời tốt cho chủ đề 1"})
    assert first.json()["finished"] is False
    internal = main.store.get_session(session_id)
    assert internal.current_concept_id == "c2"
    assert internal.progress["c1"].status == "mastered"
    assert client.get(f"/api/sessions/{session_id}/insights").status_code == 404

    second = client.post(f"/api/sessions/{session_id}/messages", json={"text": "Câu trả lời tốt cho chủ đề 2"})
    assert second.json()["finished"] is True
    late = client.post(f"/api/sessions/{session_id}/messages", json={"text": "Thêm"})
    assert late.status_code == 409

    public = client.get(f"/api/sessions/{session_id}").json()
    assert "evaluations" not in public and "progress" not in public
    assert [t["role"] for t in public["turns"]] == ["interviewer", "learner", "interviewer", "learner", "interviewer"]

    report = client.post(f"/api/sessions/{session_id}/finish")
    assert report.status_code == 200, report.text
    body = report.json()
    assert body["overall_level"] == "strong"
    assert body["assessed_concepts"] == body["total_concepts"] == 2
    assert "summary_for_teacher" not in body
    assert [c["concept_id"] for c in body["concepts"]] == ["c1", "c2"]
    assert body["concepts"][0]["strengths"] == ["Rõ ràng"]
    assert client.get(f"/api/sessions/{session_id}/report").status_code == 200


def test_voice_socket_rejects_text_session(client, document):
    session = client.post("/api/sessions", json={"document_id": document["id"], "mode": "text"}).json()["session"]
    with pytest.raises(Exception):
        with client.websocket_connect(f"/api/sessions/{session['id']}/voice") as ws:
            ws.receive_text()


def test_early_finish_reports_coverage_without_overall_grade(client, document):
    session_id = client.post(
        "/api/sessions", json={"document_id": document["id"], "mode": "text"}
    ).json()["session"]["id"]
    assert client.post(f"/api/sessions/{session_id}/messages", json={"text": "Câu trả lời tốt"}).status_code == 200

    response = client.post(f"/api/sessions/{session_id}/finish")
    assert response.status_code == 200, response.text
    report = response.json()
    assert report["overall_score"] is None
    assert report["overall_level"] == "not_assessed"
    assert report["assessed_concepts"] == 1
    assert report["total_concepts"] == 2
    assert report["concepts"][1]["level"] == "not_assessed"
    assert "chưa đủ dữ liệu" in report["summary_for_learner"]
    assert "summary_for_teacher" not in report

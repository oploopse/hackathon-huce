"""Chạy trọn một buổi phỏng vấn văn bản qua API với LLM giả, không cần GEMINI_API_KEY."""

import pytest


def test_full_text_interview(client, document):
    assert [c["id"] for c in document["concepts"]] == ["c1", "c2"]

    created = client.post("/api/sessions", json={"document_id": document["id"], "learner_name": "Lan", "mode": "text"})
    assert created.status_code == 200, created.text
    session_id = created.json()["session"]["id"]
    assert created.json()["message"]

    first = client.post(f"/api/sessions/{session_id}/messages", json={"text": "Câu trả lời tốt cho chủ đề 1"})
    assert first.json()["finished"] is False
    insights = client.get(f"/api/sessions/{session_id}/insights").json()
    assert insights["current_concept_id"] == "c2"
    assert insights["concepts"][0]["status"] == "mastered"

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
    assert [c["concept_id"] for c in body["concepts"]] == ["c1", "c2"]
    assert body["concepts"][0]["strengths"] == ["Rõ ràng"]
    assert client.get(f"/api/sessions/{session_id}/report").status_code == 200


def test_voice_socket_rejects_text_session(client, document):
    session = client.post("/api/sessions", json={"document_id": document["id"], "mode": "text"}).json()["session"]
    with pytest.raises(Exception):
        with client.websocket_connect(f"/api/sessions/{session['id']}/voice") as ws:
            ws.receive_text()

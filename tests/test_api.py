from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health_reports_models():
    response = client.get("/api/health")
    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert set(body["models"]) == {"brain", "fast", "live"}


def test_index_page_is_served():
    response = client.get("/")
    assert response.status_code == 200
    assert "AI Interviewer" in response.text


def test_upload_rejects_unsupported_file():
    response = client.post("/api/documents", files={"file": ("slides.pptx", b"data")})
    assert response.status_code == 400


def test_upload_rejects_document_without_text():
    response = client.post("/api/documents", files={"file": ("empty.txt", b"   \n\n  ")})
    assert response.status_code == 400


def test_unknown_session_returns_404():
    assert client.get("/api/sessions/000000000000").status_code == 404
    assert client.get("/api/sessions/not-an-id").status_code == 404

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
    assert "Socratic Exam" in response.text
    assert '<script type="module" src="/js/main.js">' in response.text

    legacy = client.get("/legacy.html")
    assert legacy.status_code == 200
    assert "AI Interviewer" in legacy.text


def test_access_token_guards_api_until_login(client, monkeypatch):
    monkeypatch.setattr("app.main.settings.app_access_token", "secret-token")

    assert client.get("/api/documents").status_code == 401
    assert client.get("/api/health").status_code == 200
    assert client.post("/api/auth/login", json={"token": "wrong"}).status_code == 401

    login = client.post("/api/auth/login", json={"token": "secret-token"})
    assert login.status_code == 200
    assert "httponly" in login.headers["set-cookie"].lower()
    assert client.get("/api/documents").status_code == 200

    client.cookies.clear()
    assert client.get("/api/documents", headers={"Authorization": "Bearer secret-token"}).status_code == 200


def test_upload_rejects_unsupported_file():
    response = client.post("/api/documents", files={"file": ("slides.pptx", b"data")})
    assert response.status_code == 400


def test_upload_rejects_document_without_text():
    response = client.post("/api/documents", files={"file": ("empty.txt", b"   \n\n  ")})
    assert response.status_code == 400


def test_unknown_session_returns_404():
    assert client.get("/api/sessions/000000000000").status_code == 404
    assert client.get("/api/sessions/not-an-id").status_code == 404

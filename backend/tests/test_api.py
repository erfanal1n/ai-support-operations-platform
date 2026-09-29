from fastapi.testclient import TestClient

from backend.app.main import create_app
from backend.app.settings import Settings


def test_health_response():
    client = TestClient(create_app(Settings()))
    assert client.get("/health").json() == {"status": "ok"}


def test_session_reports_auth_and_triage_flags():
    settings = Settings()
    response = TestClient(create_app(settings)).get("/api/session")
    assert response.json() == {"authRequired": False, "operator": None, "triageEnabled": False}


"""The service key is required on every request except /health once it is set.
A request without X-Forwarded-For is not "internal"; that header is the
caller's to send or omit.

    python -m unittest tests.test_api_key_auth      # needs fastapi + httpx
"""

from __future__ import annotations

import unittest

try:
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from app.api_key_auth import APIKeyMiddleware

    _IMPORT_ERROR: Exception | None = None
except Exception as _exc:  # pragma: no cover - environment-dependent
    FastAPI = TestClient = APIKeyMiddleware = None  # type: ignore[assignment]
    _IMPORT_ERROR = _exc


@unittest.skipIf(
    _IMPORT_ERROR is not None, f"fastapi/httpx unavailable: {_IMPORT_ERROR}"
)
class ApiKeyMiddlewareTest(unittest.TestCase):
    def setUp(self) -> None:
        app = FastAPI()
        app.add_middleware(APIKeyMiddleware, api_key="s3cret")

        @app.get("/health")
        def health():
            return {"ok": True}

        @app.post("/pii")
        def pii():
            return {"ok": True}

        self.client = TestClient(app)

    def test_missing_key_without_forwarded_for_is_refused(self) -> None:
        self.assertEqual(self.client.post("/pii").status_code, 401)

    def test_wrong_key_is_refused(self) -> None:
        self.assertEqual(
            self.client.post("/pii", headers={"X-API-Key": "nope"}).status_code, 401
        )

    def test_right_key_passes(self) -> None:
        self.assertEqual(
            self.client.post("/pii", headers={"X-API-Key": "s3cret"}).status_code, 200
        )

    def test_health_stays_open(self) -> None:
        self.assertEqual(self.client.get("/health").status_code, 200)


if __name__ == "__main__":
    unittest.main()

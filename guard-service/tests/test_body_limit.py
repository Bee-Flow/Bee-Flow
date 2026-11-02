"""A request body over GUARD_MAX_BODY_BYTES is a 413 before it is parsed.

python -m unittest tests.test_body_limit      # needs fastapi + httpx
"""

from __future__ import annotations

import unittest

try:
    from app.limits import TOO_LARGE, BodySizeLimitMiddleware
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    _IMPORT_ERROR: Exception | None = None
except Exception as _exc:  # pragma: no cover - environment-dependent
    FastAPI = TestClient = BodySizeLimitMiddleware = None  # type: ignore[assignment]
    _IMPORT_ERROR = _exc

LIMIT = 64


@unittest.skipIf(
    _IMPORT_ERROR is not None, f"fastapi/httpx unavailable: {_IMPORT_ERROR}"
)
class BodySizeLimitTest(unittest.TestCase):
    def setUp(self) -> None:
        app = FastAPI()
        self.parsed: list[int] = []

        @app.post("/pii")
        async def pii(body: dict) -> dict:  # type: ignore[type-arg]
            self.parsed.append(len(body["text"]))
            return {"ok": True}

        app.add_middleware(BodySizeLimitMiddleware, max_bytes=LIMIT)
        self.client = TestClient(app)

    def test_a_body_within_the_limit_is_served(self) -> None:
        r = self.client.post("/pii", json={"text": "x" * 10})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(self.parsed, [10])

    def test_a_declared_body_over_the_limit_is_413_before_parsing(self) -> None:
        r = self.client.post("/pii", json={"text": "x" * (LIMIT * 4)})
        self.assertEqual(r.status_code, 413)
        self.assertEqual(r.json()["detail"], TOO_LARGE)
        self.assertEqual(self.parsed, [])

    def test_a_streamed_body_over_the_limit_is_413(self) -> None:
        def chunks():
            for _ in range(8):
                yield b'{"text": "' + b"x" * 20 + b'"}'

        r = self.client.post(
            "/pii", content=chunks(), headers={"content-type": "application/json"}
        )
        self.assertEqual(r.status_code, 413)
        self.assertEqual(self.parsed, [])

    def test_the_limit_is_inclusive(self) -> None:
        body = b'{"text": "' + b"x" * (LIMIT - len(b'{"text": ""}')) + b'"}'
        self.assertEqual(len(body), LIMIT)
        r = self.client.post(
            "/pii", content=body, headers={"content-type": "application/json"}
        )
        self.assertEqual(r.status_code, 200)

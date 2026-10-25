"""Run: python -m unittest discover -s python-shared/tests -t python-shared (needs fastapi + httpx)"""

import unittest

from beeflow_service.api_key_auth import APIKeyMiddleware
from fastapi import FastAPI
from fastapi.testclient import TestClient


def make_client() -> TestClient:
    app = FastAPI()
    app.add_middleware(APIKeyMiddleware, api_key="s3cret")

    @app.get("/health")
    def health() -> dict[str, bool]:
        return {"ok": True}

    @app.get("/work")
    def work() -> dict[str, bool]:
        return {"ok": True}

    return TestClient(app)


class ApiKey(unittest.TestCase):
    def setUp(self) -> None:
        self.client = make_client()

    def test_health_is_open(self):
        self.assertEqual(self.client.get("/health").status_code, 200)

    def test_other_routes_need_the_key(self):
        self.assertEqual(self.client.get("/work").status_code, 401)
        self.assertEqual(
            self.client.get("/work", headers={"X-API-Key": "nope"}).status_code, 401
        )
        self.assertEqual(
            self.client.get("/work", headers={"X-API-Key": "s3cret"}).status_code, 200
        )

    def test_forwarded_for_does_not_make_a_request_internal(self):
        r = self.client.get("/work", headers={"X-Forwarded-For": "10.0.0.1"})
        self.assertEqual(r.status_code, 401)

    def test_a_non_ascii_key_is_a_401_not_a_crash(self):
        r = self.client.get("/work", headers={"X-API-Key": "é".encode("latin-1")})
        self.assertEqual(r.status_code, 401)


if __name__ == "__main__":
    unittest.main()

"""API-key check shared by every route except /health.

The key is required on every request once it is configured. An earlier
version trusted any request without X-Forwarded-For as "internal", which made
the check depend on a header the caller controls.
"""

from __future__ import annotations

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse


class APIKeyMiddleware(BaseHTTPMiddleware):
    def __init__(self, app, api_key: str) -> None:
        super().__init__(app)
        self._api_key = api_key

    async def dispatch(self, request, call_next):
        if request.url.path.startswith("/health"):
            return await call_next(request)
        if request.headers.get("X-API-Key", "") != self._api_key:
            return JSONResponse(
                {"error": "Invalid or missing API key"}, status_code=401
            )
        return await call_next(request)

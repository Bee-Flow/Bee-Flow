"""API-key check shared by every route except /health.

The key is required on every request once it is configured. An earlier
version trusted any request without X-Forwarded-For as "internal", which made
the check depend on a header the caller controls.
"""

from __future__ import annotations

import hmac

from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.types import ASGIApp


class APIKeyMiddleware(BaseHTTPMiddleware):
    def __init__(self, app: ASGIApp, api_key: str) -> None:
        super().__init__(app)
        self._api_key = api_key.encode()

    async def dispatch(
        self, request: Request, call_next: RequestResponseEndpoint
    ) -> Response:
        if request.url.path.startswith("/health"):
            return await call_next(request)
        # Constant-time compare on bytes: compare_digest raises TypeError on a
        # non-ASCII str, and a header may carry any latin-1 character.
        sent = request.headers.get("X-API-Key", "").encode()
        if not hmac.compare_digest(sent, self._api_key):
            return JSONResponse(
                {"error": "Invalid or missing API key"}, status_code=401
            )
        return await call_next(request)

"""API-key check on every route except /health, as in guard-service.

Mounted only when a key is configured (CLASSIFY_API_KEY, else
SERVICES_API_KEY): with neither set the service is open, which is the
self-host default where the port is bound to 127.0.0.1 and the compose network.
Once set, the key is required on every request; no header the caller controls
(X-Forwarded-For or otherwise) makes a request "internal".
"""

from __future__ import annotations

import hmac

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse


class APIKeyMiddleware(BaseHTTPMiddleware):
    def __init__(self, app, api_key: str) -> None:
        super().__init__(app)
        self._api_key = api_key.encode()

    async def dispatch(self, request, call_next):
        if request.url.path.startswith("/health"):
            return await call_next(request)
        sent = request.headers.get("X-API-Key", "").encode()
        if not hmac.compare_digest(sent, self._api_key):
            return JSONResponse(
                {"error": "Invalid or missing API key"}, status_code=401
            )
        return await call_next(request)

"""Request body bound, in front of JSON parsing.

A body over the limit is a 413 before any of it is parsed or scanned: the
scan budget (pii_hard_max_chars) bounds the TEXT the service will hold, this
bounds the BYTES it will read to get there, so a request that is all padding
costs a header check, not a model call. Same middleware as classify-service.
"""

from __future__ import annotations

from fastapi import HTTPException
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

TOO_LARGE = "body_too_large"


class BodySizeLimitMiddleware:
    """413 for a body over ``max_bytes``, declared or streamed.

    A Content-Length over the limit is refused before a byte is read. A body
    without one (chunked) is counted as it arrives and refused the moment it
    passes the limit: the HTTPException raised from ``receive`` travels through
    FastAPI's body parsing, which re-raises HTTP errors unchanged.
    """

    def __init__(self, app: ASGIApp, max_bytes: int) -> None:
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        declared = _content_length(scope)
        if declared is not None and declared > self.max_bytes:
            await JSONResponse({"detail": TOO_LARGE}, status_code=413)(
                scope, receive, send
            )
            return

        seen = 0

        async def counted_receive() -> Message:
            nonlocal seen
            message = await receive()
            if message["type"] == "http.request":
                seen += len(message.get("body", b""))
                if seen > self.max_bytes:
                    raise HTTPException(status_code=413, detail=TOO_LARGE)
            return message

        await self.app(scope, counted_receive, send)


def _content_length(scope: Scope) -> int | None:
    for name, value in scope.get("headers", ()):
        if name == b"content-length":
            try:
                return int(value)
            except ValueError:
                return None
    return None

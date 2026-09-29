"""The two bounds in front of the model: request body size and admission.

Both answer before any inference is spent. A body over the limit is a 413; a
request that finds max_concurrency running and max_queue already waiting is a
429 "busy", so a burst turns into fast refusals the caller can retry instead of
a queue of requests that time out one after another.
"""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import HTTPException
from starlette.responses import JSONResponse

TOO_LARGE = "body_too_large"


class Busy(Exception):
    """The gate is full."""


class AdmissionGate:
    """At most ``max_concurrency`` inside, at most ``max_queue`` more waiting.

    Single event loop, so the counter needs no lock. The semaphore is made on
    first use and remade if the loop changes, which only happens under test.
    """

    def __init__(self, max_concurrency: int, max_queue: int) -> None:
        self.max_concurrency = max_concurrency
        self.limit = max_concurrency + max_queue
        self.admitted = 0
        self._sem: asyncio.Semaphore | None = None
        self._loop: asyncio.AbstractEventLoop | None = None

    def _semaphore(self) -> asyncio.Semaphore:
        loop = asyncio.get_running_loop()
        if self._sem is None or self._loop is not loop:
            self._sem = asyncio.Semaphore(self.max_concurrency)
            self._loop = loop
        return self._sem

    @asynccontextmanager
    async def slot(self) -> AsyncIterator[None]:
        if self.admitted >= self.limit:
            raise Busy
        sem = self._semaphore()
        self.admitted += 1
        try:
            async with sem:
                yield
        finally:
            self.admitted -= 1


class BodySizeLimitMiddleware:
    """413 for a body over ``max_bytes``, declared or streamed.

    A Content-Length over the limit is refused before a byte is read. A body
    without one (chunked) is counted as it arrives and refused the moment it
    passes the limit: the HTTPException raised from ``receive`` travels through
    FastAPI's body parsing, which re-raises HTTP errors unchanged.
    """

    def __init__(self, app, max_bytes: int) -> None:
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope, receive, send) -> None:
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

        async def counted_receive():
            nonlocal seen
            message = await receive()
            if message["type"] == "http.request":
                seen += len(message.get("body", b""))
                if seen > self.max_bytes:
                    raise HTTPException(status_code=413, detail=TOO_LARGE)
            return message

        await self.app(scope, counted_receive, send)


def _content_length(scope) -> int | None:
    for name, value in scope.get("headers", ()):
        if name == b"content-length":
            try:
                return int(value)
            except ValueError:
                return None
    return None

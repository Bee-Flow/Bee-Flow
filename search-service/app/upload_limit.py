"""Bounded reading of multipart uploads."""

from __future__ import annotations

from fastapi import HTTPException


async def read_bounded(file, max_bytes: int, chunk_size: int = 1024 * 1024) -> bytes:
    """Read ``file`` up to ``max_bytes``; a larger upload is a 413, not a memory spike."""
    chunks: list[bytes] = []
    total = 0
    while chunk := await file.read(chunk_size):
        total += len(chunk)
        if total > max_bytes:
            raise HTTPException(
                status_code=413,
                detail=f"Upload exceeds {max_bytes // (1024 * 1024)} MB",
            )
        chunks.append(chunk)
    return b"".join(chunks)

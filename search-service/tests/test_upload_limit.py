"""An upload past the cap is a 413, not a memory spike. Run: pytest search-service/tests"""

import asyncio
import os
import sys

import pytest
from fastapi import HTTPException

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.upload_limit import read_bounded  # noqa: E402


class FakeUpload:
    def __init__(self, data: bytes) -> None:
        self._data = data
        self._pos = 0

    async def read(self, size: int) -> bytes:
        chunk = self._data[self._pos : self._pos + size]
        self._pos += size
        return chunk


def test_small_upload_is_returned_whole():
    assert (
        asyncio.run(read_bounded(FakeUpload(b"x" * 10), max_bytes=16, chunk_size=4))
        == b"x" * 10
    )


def test_upload_over_the_cap_is_a_413():
    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(read_bounded(FakeUpload(b"x" * 40), max_bytes=16, chunk_size=4))
    assert exc_info.value.status_code == 413

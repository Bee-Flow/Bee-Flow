"""POST /embed (cache through RedisCache's public methods) and the KB ingest
paths (delete + reinsert in one transaction, embedding count checked before
the delete). Run: pytest search-service/tests
"""

import asyncio
import json
import os
import sys
from contextlib import asynccontextmanager

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

pytest.importorskip("pydantic_settings")
from fakes import FakeRedis  # noqa: E402
from fastapi import HTTPException  # noqa: E402

from app.models import EmbedRequest, IngestRequest  # noqa: E402
from app.routers import inference_api, ingest  # noqa: E402


def run(coro):
    return asyncio.run(coro)


class StubInference:
    def __init__(self, vectors=None, drop=0):
        self.vectors = vectors
        self.drop = drop
        self.calls = []

    async def embed(self, texts):
        self.calls.append(list(texts))
        out = [[float(len(t)), 0.5] for t in texts]
        return out[: len(out) - self.drop] if self.drop else out


def test_embed_endpoint_computes_then_serves_from_cache(monkeypatch):
    redis = FakeRedis()
    inf = StubInference()
    monkeypatch.setattr(inference_api, "get_http", lambda: object())
    monkeypatch.setattr(inference_api, "get_redis", lambda: redis)
    monkeypatch.setattr(inference_api, "InferenceClient", lambda http: inf)

    first = run(inference_api.embed_texts(EmbedRequest(input=["hello", "hi"])))
    assert first.cached == 0
    assert first.embeddings == [[5.0, 0.5], [2.0, 0.5]]
    assert any(k.startswith("emb:") for k in redis.store)
    assert json.loads(next(iter(redis.store.values())))

    second = run(inference_api.embed_texts(EmbedRequest(input=["hello", "new"])))
    assert second.cached == 1
    assert second.embeddings[0] == [5.0, 0.5]
    assert inf.calls[-1] == ["new"]


class TxConn:
    def __init__(self, fail_on_insert=None, store=None):
        self.store = store if store is not None else ["old-1", "old-2"]
        self.fail_on_insert = fail_on_insert
        self.inserts = 0
        self._snapshot = None

    @asynccontextmanager
    async def transaction(self):
        self._snapshot = list(self.store)
        try:
            yield
        except BaseException:
            self.store[:] = self._snapshot
            raise

    async def execute(self, sql, *args):
        if sql.lstrip().upper().startswith("DELETE"):
            self.store.clear()
            return
        self.inserts += 1
        if self.fail_on_insert == self.inserts:
            raise RuntimeError("connection dropped")
        self.store.append(args[6])


class TxPool:
    def __init__(self, conn):
        self.conn = conn

    @asynccontextmanager
    async def acquire(self):
        yield self.conn


def _patch(monkeypatch, conn, inf):
    monkeypatch.setattr(ingest, "get_db", lambda: TxPool(conn))
    monkeypatch.setattr(ingest, "get_http", lambda: object())
    import app.services.inference as inference_mod

    monkeypatch.setattr(inference_mod, "get_inference_client", lambda *a, **k: inf)


def _req():
    return IngestRequest(
        tenant_id="t",
        knowledge_base_id="kb",
        document_id="d",
        content="Some content. " * 400,
        title="T",
    )


def test_json_ingest_rolls_back_when_an_insert_fails(monkeypatch):
    conn = TxConn(fail_on_insert=2)
    _patch(monkeypatch, conn, StubInference())
    with pytest.raises(RuntimeError):
        run(ingest.ingest_json(_req()))
    assert conn.store == ["old-1", "old-2"]


def test_json_ingest_replaces_chunks_on_success(monkeypatch):
    conn = TxConn()
    _patch(monkeypatch, conn, StubInference())
    res = run(ingest.ingest_json(_req()))
    assert res.chunks_created == len(conn.store) > 0
    assert "old-1" not in conn.store


def test_short_embedding_response_fails_before_the_delete(monkeypatch):
    conn = TxConn()
    _patch(monkeypatch, conn, StubInference(drop=1))
    with pytest.raises(HTTPException) as e:
        run(ingest.ingest_json(_req()))
    assert e.value.status_code == 502
    assert conn.store == ["old-1", "old-2"]
    assert conn.inserts == 0

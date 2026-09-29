"""The admission gate (429 busy) and the body-size limit (413)."""

from __future__ import annotations

import asyncio

import httpx
import pytest

from app.limits import AdmissionGate, Busy
from app.routers import classify as classify_router

BODY = {"texts": ["x"], "labels": ["a"]}


def test_gate_admits_running_plus_queued_then_refuses():
    async def scenario():
        gate = AdmissionGate(max_concurrency=1, max_queue=1)
        release = asyncio.Event()
        inside: list[int] = []

        async def hold(n):
            async with gate.slot():
                inside.append(n)
                await release.wait()

        first = asyncio.create_task(hold(1))
        second = asyncio.create_task(hold(2))
        await asyncio.sleep(0.01)
        assert gate.admitted == 2
        assert inside == [1]  # the second one waits: concurrency is 1
        with pytest.raises(Busy):
            async with gate.slot():
                pass
        release.set()
        await asyncio.gather(first, second)
        assert inside == [1, 2]
        assert gate.admitted == 0

    asyncio.run(scenario())


def test_gate_with_no_queue_refuses_the_second():
    async def scenario():
        gate = AdmissionGate(max_concurrency=1, max_queue=0)
        async with gate.slot():
            with pytest.raises(Busy):
                async with gate.slot():
                    pass
        async with gate.slot():  # free again
            pass

    asyncio.run(scenario())


def test_gate_survives_a_new_event_loop():
    gate = AdmissionGate(max_concurrency=1, max_queue=0)

    async def once():
        async with gate.slot():
            pass

    asyncio.run(once())
    asyncio.run(once())
    assert gate.admitted == 0


def test_full_gate_answers_429_busy(fake, make_app, tune):
    tune(max_concurrency=1, max_queue=2)
    fake.block = True
    app = make_app()

    async def scenario():
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
            admitted = [
                asyncio.create_task(c.post("/classify", json=BODY)) for _ in range(3)
            ]
            gate = classify_router.get_gate()
            for _ in range(500):
                if gate.admitted == 3 and fake.started.is_set():
                    break
                await asyncio.sleep(0.01)
            assert gate.admitted == 3
            refused = await c.post("/classify", json=BODY)
            fake.release.set()
            done = await asyncio.gather(*admitted)
        return refused, done

    refused, done = asyncio.run(scenario())
    assert refused.status_code == 429
    assert refused.json() == {"detail": "busy"}
    assert [r.status_code for r in done] == [200, 200, 200]
    assert len(fake.calls) == 3


def test_declared_oversize_body_is_413(client, fake):
    r = client.post(
        "/classify",
        content=b"{" + b" " * (256 * 1024) + b"}",
        headers={"Content-Type": "application/json"},
    )
    assert r.status_code == 413
    assert r.json() == {"detail": "body_too_large"}
    assert fake.calls == []


def test_streamed_oversize_body_is_413(client, fake):
    def chunks():
        for _ in range(40):
            yield b" " * 8192

    r = client.post(
        "/classify", content=chunks(), headers={"Content-Type": "application/json"}
    )
    assert r.status_code == 413
    assert fake.calls == []


def test_body_just_under_the_limit_is_read(client):
    text = "x" * (200 * 1024)
    assert (
        client.post("/classify", json={"texts": [text], "labels": ["a"]}).status_code
        == 200
    )

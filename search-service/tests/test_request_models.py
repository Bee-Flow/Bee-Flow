"""Contract tests for the search-service request models (U9).

Every request model rejects unknown fields (extra="forbid"): a caller newer
than this build gets a loud 422 instead of a silently mangled request. The
parity tests pin the EXACT payloads the Node server sends today, so forbid
can never break a live caller without a test saying which one:

  * /tools/kb-search  — server/integrations/kbSearchTools.js:253-260
                        (always includes ``inference_routing``, even as null)
  * /tools/search     — server/integrations/agentSearchTools.js:134-139
  * /kb/ingest/json   — server/core/kb/kbIngestionHelpers.js:578-587

NOTE: the Node shim at server/routes/search.js re-implements this surface in
JS and destructures fields itself — a 422 from THIS service proves nothing
about deployments whose SEARCH_SERVICE_URL points at the shim.

The model layer needs only pydantic (app.models has no other imports); the
HTTP-layer test needs the full router import chain (fastapi, httpx, redis,
pydantic-settings, …) and skips where that is absent. There is no CI job for
search-service tests yet — run in the container: pytest search-service/tests
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest

pytest.importorskip("pydantic", reason="pydantic not installed")

from pydantic import ValidationError  # noqa: E402

from app.models import (  # noqa: E402
    EmbedRequest,
    IngestRequest,
    KBParams,
    KBScope,
    RerankRequest,
    ResponseParams,
    SearchRequest,
    SimpleSearchRequest,
    WebParams,
)

# One minimal-valid construction per request model; the forbid test appends
# an unknown key to each.
MINIMAL_VALID = [
    (KBScope, {"tenant_id": "t1"}),
    (WebParams, {}),
    (KBParams, {}),
    (ResponseParams, {}),
    (SearchRequest, {"query": "q"}),
    (
        IngestRequest,
        {"tenant_id": "t1", "knowledge_base_id": "kb1", "document_id": "d1"},
    ),
    (SimpleSearchRequest, {"tenant_id": "t1", "kb_ids": ["kb1"], "query": "q"}),
    (EmbedRequest, {"input": ["hello"]}),
    (RerankRequest, {"query": "q", "documents": ["doc"]}),
]


def _assert_extra_forbidden(exc: ValidationError, field: str) -> None:
    errors = exc.errors()
    assert any(e.get("type") == "extra_forbidden" for e in errors), errors
    assert any(field in (e.get("loc") or ()) for e in errors), errors


@pytest.mark.parametrize(
    "model, payload", MINIMAL_VALID, ids=lambda p: getattr(p, "__name__", "")
)
def test_every_request_model_rejects_unknown_fields(model, payload):
    model(**payload)  # the minimal payload itself must stay valid
    with pytest.raises(ValidationError) as exc_info:
        model(**{**payload, "field_from_the_future": 1})
    _assert_extra_forbidden(exc_info.value, "field_from_the_future")


def test_unknown_field_in_nested_model_is_rejected():
    # forbid must hold inside nested request bodies too — an unknown knob in
    # web/kb/response would otherwise be dropped while the rest "works".
    with pytest.raises(ValidationError) as exc_info:
        SearchRequest(query="q", web={"max_results": 5, "field_from_the_future": 1})
    _assert_extra_forbidden(exc_info.value, "field_from_the_future")


def test_kb_search_payload_parity_with_kbSearchTools():
    # kbSearchTools.js:253-260 — inference_routing is ALWAYS present, null
    # when unresolved. Both shapes must validate, or every agent KB search
    # through the remote provider 422s.
    base = {
        "tenant_id": "user-1",
        "kb_ids": ["kb-1", "kb-2"],
        "query": "hoe werkt facturering?",
        "top_k": 5,
        "rerank": True,
    }
    for routing in (None, {"embed": {"provider": "azure"}, "rerank": {}}):
        req = SimpleSearchRequest(**base, inference_routing=routing)
        assert req.inference_routing == routing


def test_agent_search_payload_parity_with_agentSearchTools():
    # agentSearchTools.js:134-139.
    req = SearchRequest(
        query="latest EU AI act status",
        mode="web",
        web={"max_results": 5, "fetch_top_n": 3},
        response={
            "include_citations": True,
            "max_tokens_markdown": 1200,
            "detail_level": "detailed",
        },
    )
    assert req.web.max_results == 5
    assert req.response.detail_level.value == "detailed"


def test_ingest_payload_parity_with_kbIngestionHelpers():
    # kbIngestionHelpers.js:578-587 — with and without the azure spread.
    base = {
        "tenant_id": "t1",
        "knowledge_base_id": "kb1",
        "document_id": "doc1",
        "content": "chunk me",
        "title": "Handleiding",
        "source_uri": "https://example.com/doc",
        "lang": "nl",
    }
    IngestRequest(**base)
    IngestRequest(
        **base,
        use_azure=True,
        azure_endpoint="https://example.openai.azure.com",
        azure_key="k",
        azure_model="text-embedding-3-large",
    )


def test_unknown_request_field_yields_422_over_http():
    # Full-stack proof on a bare app (no lifespan): FastAPI rejects the body
    # before the handler touches db/redis. Needs the router's import chain.
    pytest.importorskip("fastapi", reason="fastapi not installed")
    pytest.importorskip("httpx", reason="TestClient needs httpx")
    try:
        from app.routers.search import router
    except Exception as exc:  # pragma: no cover - environment-dependent
        pytest.skip(f"search router import chain unavailable: {exc}")
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    app = FastAPI()
    app.include_router(router)
    client = TestClient(app)
    res = client.post(
        "/tools/kb-search",
        json={
            "tenant_id": "t1",
            "kb_ids": ["kb1"],
            "query": "q",
            "field_from_the_future": 1,
        },
    )
    assert res.status_code == 422, res.text
    assert "field_from_the_future" in res.text

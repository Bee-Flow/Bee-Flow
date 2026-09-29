"""
Ingest router — POST /kb/ingest (file upload or text), POST /kb/documents (manage)
"""

from __future__ import annotations

import uuid
from typing import Optional

from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from app.chunking.splitter import chunk_text
from app.config import settings
from app.db.queries import DELETE_DOCUMENT_CHUNKS_SQL, INSERT_CHUNK_SQL
from app.dependencies import get_db, get_http
from app.extractors.pdf import extract_pdf_text, has_extractable_text
from app.models import IngestRequest, IngestResponse
from app.observability.logging import latency, logger
from app.services.inference import InferenceClient
from app.upload_limit import read_bounded

router = APIRouter(prefix="/kb", tags=["ingestion"])


@router.post("/ingest", response_model=IngestResponse)
async def ingest_document(  # noqa: PLR0912, PLR0913
    tenant_id: str = Form(...),
    knowledge_base_id: str = Form(...),
    document_id: Optional[str] = Form(None),
    title: Optional[str] = Form(None),
    source_uri: Optional[str] = Form(None),
    lang: Optional[str] = Form(None),
    content: Optional[str] = Form(None),
    file: Optional[UploadFile] = File(None),
) -> IngestResponse:
    """
    Ingest a document into the knowledge base.
    Accepts either a file upload (PDF) or text content.
    """
    db = get_db()
    http = get_http()
    inference = InferenceClient(http)

    # Generate document_id if not provided
    doc_id = document_id or str(uuid.uuid4())
    tenant = tenant_id
    kb_id = knowledge_base_id

    # Get text content from file or direct text
    text_content = ""

    if file:
        file_bytes = await read_bounded(file, settings.ingest_max_upload_bytes)
        filename = file.filename or ""

        if filename.lower().endswith(".pdf"):
            # Check if PDF has extractable text
            if has_extractable_text(file_bytes):
                text_content = extract_pdf_text(file_bytes, title=title)
            else:
                # Try OCR
                try:
                    from app.extractors.ocr import is_available, ocr_pdf_pages

                    if is_available():
                        text_content = ocr_pdf_pages(file_bytes, title=title)
                    else:
                        raise HTTPException(
                            status_code=422,
                            detail="PDF appears to be scanned but OCR is not available",
                        )
                except ImportError:
                    raise HTTPException(
                        status_code=422,
                        detail="PDF appears to be scanned but OCR module is not installed",
                    )
        else:
            # Treat as plain text
            text_content = file_bytes.decode("utf-8", errors="ignore")

    elif content:
        text_content = content
    else:
        raise HTTPException(
            status_code=400, detail="Either file or content must be provided"
        )

    if not text_content.strip():
        raise HTTPException(
            status_code=422, detail="No text could be extracted from the document"
        )

    # Chunk the content
    with latency.track("chunking"):
        chunks = chunk_text(text_content)

    if not chunks:
        raise HTTPException(status_code=422, detail="Document produced no chunks")

    logger.info(
        "Ingesting document %s: %d chunks from %d chars",
        doc_id,
        len(chunks),
        len(text_content),
    )

    # Compute embeddings for all chunks (batch)
    chunk_texts = [c.text for c in chunks]
    with latency.track("batch_embed"):
        embeddings = await inference.embed(chunk_texts)

    # Delete existing chunks for this document (re-ingestion)
    async with db.acquire() as conn:
        await conn.execute(
            DELETE_DOCUMENT_CHUNKS_SQL,
            str(tenant),
            str(kb_id),
            str(doc_id),
        )

        # Insert new chunks
        for chunk, embedding in zip(chunks, embeddings):
            await conn.execute(
                INSERT_CHUNK_SQL,
                tenant,
                kb_id,
                str(doc_id),
                chunk.chunk_id,
                lang,
                title,
                chunk.text,
                str(embedding),
                source_uri,
            )

    logger.info("Ingestion complete: document=%s chunks=%d", doc_id, len(chunks))

    return IngestResponse(
        document_id=doc_id,
        chunks_created=len(chunks),
        status="ok",
    )


@router.get("/{kb_id}/documents/{document_id}/content")
async def get_document_content(
    kb_id: str,
    document_id: str,
    tenant_id: str,
) -> dict:
    """Get concatenated chunk content for a document (for re-indexing)."""
    db = get_db()

    async with db.acquire() as conn:
        rows = await conn.fetch(
            """SELECT content FROM kb_chunks
               WHERE tenant_id = $1
                 AND knowledge_base_id = $2
                 AND document_id = $3
               ORDER BY chunk_id ASC""",
            tenant_id,
            kb_id,
            document_id,
        )

    if not rows:
        raise HTTPException(status_code=404, detail="No chunks found for document")

    content = "\n\n".join(row["content"] for row in rows)
    return {"document_id": document_id, "content": content, "chunk_count": len(rows)}


@router.delete("/documents/{document_id}")
async def delete_document(
    document_id: str,
    tenant_id: str,
    knowledge_base_id: str,
) -> dict:
    """Delete all chunks for a document."""
    db = get_db()

    async with db.acquire() as conn:
        await conn.execute(
            DELETE_DOCUMENT_CHUNKS_SQL,
            tenant_id,
            knowledge_base_id,
            document_id,
        )
    logger.info("Deleted chunks for document %s", document_id)
    return {"status": "ok", "document_id": document_id}


@router.post("/ingest/json", response_model=IngestResponse)
async def ingest_json(request: IngestRequest) -> IngestResponse:
    """
    JSON-based ingestion endpoint (used by the server proxy).
    Accepts content as a JSON body instead of Form data.
    When use_azure=True, uses Azure OpenAI for embeddings instead of local vLLM.
    """
    if not request.content or not request.content.strip():
        raise HTTPException(status_code=400, detail="content is required")

    db = get_db()
    http = get_http()

    # Use Azure or local inference based on request flag
    from app.services.inference import get_inference_client

    inference = get_inference_client(
        http,
        use_azure=request.use_azure,
        azure_endpoint=request.azure_endpoint,
        azure_key=request.azure_key,
        azure_model=request.azure_model,
    )

    if request.use_azure:
        logger.info("JSON ingest: using Azure OpenAI embeddings (use_azure=True)")

    doc_id = request.document_id
    tenant = str(request.tenant_id)
    kb_id = str(request.knowledge_base_id)

    # Chunk
    with latency.track("chunking"):
        chunks = chunk_text(request.content)

    if not chunks:
        raise HTTPException(status_code=422, detail="No chunks produced")

    logger.info(
        "JSON ingest: doc=%s chunks=%d azure=%s", doc_id, len(chunks), request.use_azure
    )

    # Embed
    chunk_texts = [c.text for c in chunks]
    with latency.track("batch_embed"):
        embeddings = await inference.embed(chunk_texts)

    # Delete old chunks, insert new
    async with db.acquire() as conn:
        await conn.execute(DELETE_DOCUMENT_CHUNKS_SQL, tenant, kb_id, str(doc_id))
        for chunk, embedding in zip(chunks, embeddings):
            await conn.execute(
                INSERT_CHUNK_SQL,
                tenant,
                kb_id,
                str(doc_id),
                chunk.chunk_id,
                request.lang,
                request.title,
                chunk.text,
                str(embedding),
                request.source_uri,
            )

    logger.info("JSON ingest complete: doc=%s chunks=%d", doc_id, len(chunks))
    return IngestResponse(document_id=doc_id, chunks_created=len(chunks), status="ok")

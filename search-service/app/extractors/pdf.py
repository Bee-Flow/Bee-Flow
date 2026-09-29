"""
PDF text extraction — PyMuPDF primary, pypdf fallback.
"""

from __future__ import annotations

import io
import re
from typing import Optional

from app.observability.logging import logger, latency

# Primary: PyMuPDF (fitz)
try:
    import fitz  # pymupdf

    HAS_PYMUPDF = True
except ImportError:
    HAS_PYMUPDF = False
    logger.warning("PyMuPDF not available")

# Fallback: pypdf
try:
    from pypdf import PdfReader

    HAS_PYPDF = True
except ImportError:
    HAS_PYPDF = False
    logger.warning("pypdf not available")


def extract_pdf_text(pdf_bytes: bytes, title: Optional[str] = None) -> str:
    """
    Extract text from a PDF, returning markdown-formatted content.
    Tries PyMuPDF first, then pypdf as fallback.
    """
    with latency.track("pdf_extract"):
        text = _pymupdf_extract(pdf_bytes, title)
        if text and len(text.strip()) > 50:
            return text

        text = _pypdf_extract(pdf_bytes, title)
        if text and len(text.strip()) > 50:
            return text

        logger.warning("PDF extraction produced no usable text")
        return ""


def has_extractable_text(pdf_bytes: bytes) -> bool:
    """Check if a PDF has extractable text (vs scanned/image-only)."""
    if not HAS_PYMUPDF:
        return True  # Assume yes if we can't check

    try:
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
        # Check first few pages for text
        total_chars = 0
        pages_to_check = min(3, doc.page_count)
        for i in range(pages_to_check):
            page = doc.load_page(i)
            total_chars += len(page.get_text().strip())
        doc.close()
        # If fewer than 20 chars per checked page, likely scanned
        return total_chars > (pages_to_check * 20)
    except Exception:
        return True


def _pymupdf_extract(pdf_bytes: bytes, title: Optional[str] = None) -> Optional[str]:  # noqa: C901, PLR0912
    """Extract with PyMuPDF, preserving basic heading structure."""
    if not HAS_PYMUPDF:
        return None

    try:
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
        parts = []

        # Document title
        if title:
            parts.append(f"# {title}")
        elif doc.metadata and doc.metadata.get("title"):
            parts.append(f"# {doc.metadata['title']}")
        else:
            parts.append("# Document")

        parts.append("")

        for page_num in range(doc.page_count):
            page = doc.load_page(page_num)

            # Try to detect headings via font size analysis
            blocks = page.get_text("dict", flags=fitz.TEXTFLAGS_TEXT)["blocks"]

            parts.append(f"## Page {page_num + 1}")
            parts.append("")

            for block in blocks:
                if block.get("type") != 0:  # text blocks only
                    continue
                for line in block.get("lines", []):
                    line_text = ""
                    max_size = 0
                    for span in line.get("spans", []):
                        line_text += span.get("text", "")
                        max_size = max(max_size, span.get("size", 12))

                    line_text = line_text.strip()
                    if not line_text:
                        continue

                    # Heuristic: large font → subheading
                    if max_size > 14 and len(line_text) < 200:
                        parts.append(f"### {line_text}")
                    else:
                        parts.append(line_text)

            parts.append("")

        doc.close()

        # Clean up excessive whitespace
        text = "\n".join(parts)
        text = re.sub(r"\n{3,}", "\n\n", text)
        return text.strip()

    except Exception as e:
        logger.debug("PyMuPDF extraction failed: %s", e)
        return None


def _pypdf_extract(pdf_bytes: bytes, title: Optional[str] = None) -> Optional[str]:
    """Fallback extraction with pypdf."""
    if not HAS_PYPDF:
        return None

    try:
        reader = PdfReader(io.BytesIO(pdf_bytes))
        parts = []

        if title:
            parts.append(f"# {title}")
        elif reader.metadata and reader.metadata.title:
            parts.append(f"# {reader.metadata.title}")
        else:
            parts.append("# Document")

        parts.append("")

        for i, page in enumerate(reader.pages):
            text = page.extract_text()
            if text and text.strip():
                parts.append(f"## Page {i + 1}")
                parts.append("")
                parts.append(text.strip())
                parts.append("")

        return "\n".join(parts).strip()

    except Exception as e:
        logger.debug("pypdf extraction failed: %s", e)
        return None

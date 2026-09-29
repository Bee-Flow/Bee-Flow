"""
OCR extraction — PaddleOCR for scanned PDFs/images.
Optional dependency: only works if paddleocr + paddlepaddle are installed.
"""

from __future__ import annotations

import io
from typing import Optional

from app.observability.logging import logger, latency

# Optional import
try:
    from paddleocr import PaddleOCR
    from PIL import Image

    HAS_PADDLEOCR = True
except ImportError:
    HAS_PADDLEOCR = False

# Lazy singleton
_ocr_instance: Optional["PaddleOCR"] = None


def _get_ocr() -> "PaddleOCR":
    """Lazy-initialize PaddleOCR on first use."""
    global _ocr_instance
    if _ocr_instance is None:
        _ocr_instance = PaddleOCR(use_angle_cls=True, lang="en", show_log=False)
    return _ocr_instance


def is_available() -> bool:
    """Check if OCR capability is available."""
    return HAS_PADDLEOCR


def ocr_pdf_pages(pdf_bytes: bytes, title: Optional[str] = None) -> str:
    """
    Convert scanned PDF pages to text via OCR.
    Requires PyMuPDF for rendering + PaddleOCR for recognition.
    """
    if not HAS_PADDLEOCR:
        logger.error("PaddleOCR not installed — cannot OCR this document")
        return ""

    try:
        import fitz
    except ImportError:
        logger.error("PyMuPDF required for PDF→image rendering for OCR")
        return ""

    with latency.track("ocr_extract"):
        try:
            doc = fitz.open(stream=pdf_bytes, filetype="pdf")
            ocr = _get_ocr()
            parts = []

            if title:
                parts.append(f"# {title}")
            else:
                parts.append("# Document (OCR)")
            parts.append("")

            for page_num in range(doc.page_count):
                page = doc.load_page(page_num)
                # Render page at 300 DPI
                pix = page.get_pixmap(dpi=300)
                img_bytes = pix.tobytes("png")
                img = Image.open(io.BytesIO(img_bytes))

                # Run OCR
                result = ocr.ocr(img, cls=True)

                parts.append(f"## Page {page_num + 1}")
                parts.append("")

                if result and result[0]:
                    lines = []
                    for line in result[0]:
                        text = line[1][0]  # (bbox, (text, confidence))
                        lines.append(text)

                    # Group close lines into paragraphs (simple newline-based)
                    parts.append(" ".join(lines))

                parts.append("")

            doc.close()
            return "\n".join(parts).strip()

        except Exception as e:
            logger.error("OCR extraction failed: %s", e)
            return ""


def ocr_image(image_bytes: bytes) -> str:
    """OCR a single image and return the extracted text."""
    if not HAS_PADDLEOCR:
        logger.error("PaddleOCR not installed")
        return ""

    try:
        img = Image.open(io.BytesIO(image_bytes))
        ocr = _get_ocr()
        result = ocr.ocr(img, cls=True)

        if result and result[0]:
            lines = [line[1][0] for line in result[0]]
            return " ".join(lines)

        return ""
    except Exception as e:
        logger.error("Image OCR failed: %s", e)
        return ""

"""
Web content extraction — trafilatura primary, readability-lxml fallback.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Optional

import trafilatura

from app.observability.logging import logger, latency

# Try to import readability — optional but strongly recommended
try:
    from readability import Document as ReadabilityDocument

    HAS_READABILITY = True
except ImportError:
    HAS_READABILITY = False
    logger.warning("readability-lxml not available; fallback extraction disabled")

try:
    from markdownify import markdownify as md

    HAS_MARKDOWNIFY = True
except ImportError:
    HAS_MARKDOWNIFY = False


@dataclass
class ExtractionResult:
    """Result of extracting content from a web page."""

    text: str
    title: Optional[str] = None
    lang: Optional[str] = None
    method: str = "trafilatura"


def extract_content(html: str, url: str = "") -> Optional[ExtractionResult]:
    """
    Extract main content from HTML.
    Primary: trafilatura. Fallback: readability-lxml → markdownify.
    """
    with latency.track("extract"):
        result = _trafilatura_extract(html, url)
        if result and len(result.text.strip()) > 100:
            return result

        # Fallback
        result = _readability_extract(html, url)
        if result and len(result.text.strip()) > 100:
            return result

        logger.warning("All extraction methods failed for %s", url)
        return None


def _trafilatura_extract(html: str, url: str) -> Optional[ExtractionResult]:
    """Primary extraction via trafilatura."""
    try:
        text = trafilatura.extract(
            html,
            include_tables=True,
            include_links=True,
            include_comments=False,
            output_format="txt",
            url=url,
        )
        if not text:
            return None

        # Get metadata for title/lang
        metadata = trafilatura.extract(
            html,
            output_format="xml",
            url=url,
            include_tables=True,
        )
        title = None
        lang = None
        if metadata:
            # Try to parse title from XML output
            title_match = re.search(r'title="([^"]*)"', metadata)
            if title_match:
                title = title_match.group(1)

        # Try getting title from HTML directly
        if not title:
            title = _extract_html_title(html)

        # Simple language detection from HTML lang attribute
        lang = _extract_html_lang(html)

        return ExtractionResult(
            text=text,
            title=title,
            lang=lang,
            method="trafilatura",
        )
    except Exception as e:
        logger.debug("trafilatura failed: %s", e)
        return None


def _readability_extract(html: str, url: str) -> Optional[ExtractionResult]:
    """Fallback extraction via readability-lxml + markdownify."""
    if not HAS_READABILITY:
        return None

    try:
        doc = ReadabilityDocument(html, url=url)
        article_html = doc.summary()
        title = doc.title()

        if HAS_MARKDOWNIFY:
            text = md(
                article_html, heading_style="ATX", strip=["img", "script", "style"]
            )
        else:
            # Strip HTML tags manually
            text = re.sub(r"<[^>]+>", " ", article_html)
            text = re.sub(r"\s+", " ", text).strip()

        if not text:
            return None

        lang = _extract_html_lang(html)

        return ExtractionResult(
            text=text,
            title=title,
            lang=lang,
            method="readability",
        )
    except Exception as e:
        logger.debug("readability fallback failed: %s", e)
        return None


def _extract_html_title(html: str) -> Optional[str]:
    """Extract <title> from HTML."""
    match = re.search(r"<title[^>]*>([^<]+)</title>", html, re.IGNORECASE)
    return match.group(1).strip() if match else None


def _extract_html_lang(html: str) -> Optional[str]:
    """Extract lang attribute from <html> tag."""
    match = re.search(r'<html[^>]*\blang=["\']?([a-zA-Z-]+)', html, re.IGNORECASE)
    return match.group(1).lower() if match else None

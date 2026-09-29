"""
Markdown normalization — cleanup, de-noise, size caps.
"""

from __future__ import annotations

import re
from typing import Optional

from app.config import settings

# ── Regex patterns for common web noise ──────────────────────────────

_NOISE_PATTERNS = [
    # Cookie consent banners
    re.compile(
        r"(?i)(we use cookies|cookie\s*policy|accept\s*cookies|by continuing|consent to|cookie settings).*?\n",
        re.DOTALL,
    ),
    # Newsletter / subscribe CTAs
    re.compile(r"(?i)(subscribe|sign\s*up for|newsletter|get updates|join our).*?\n"),
    # Navigation breadcrumbs
    re.compile(r"(?i)^(home\s*[>»›/]\s*.*?\n)", re.MULTILINE),
    # Social share buttons
    re.compile(r"(?i)(share on|tweet this|share this|follow us|like us on).*?\n"),
    # "Read more" / "Show more" links
    re.compile(
        r"(?i)^(read more|show more|see more|continue reading|view all).*?\n",
        re.MULTILINE,
    ),
    # Footer-style content
    re.compile(
        r"(?i)(all rights reserved|©|privacy policy|terms of service|terms and conditions).*?\n"
    ),
    # Login/register prompts
    re.compile(r"(?i)(log\s*in to|sign\s*in to|create an? account|register to).*?\n"),
    # Advertisement markers
    re.compile(r"(?i)(advertisement|sponsored|promoted content|ad\s*:).*?\n"),
]

# Excessive blank lines
_BLANK_LINES = re.compile(r"\n{3,}")

# Lines that are just punctuation or very short noise
_SHORT_NOISE_LINE = re.compile(r"^[\s\-=*_|•·]{1,5}$", re.MULTILINE)


def normalize_markdown(
    text: str,
    max_bytes: Optional[int] = None,
    max_tokens: Optional[int] = None,
) -> str:
    """
    Clean up extracted markdown: remove noise, collapse blank lines, enforce size caps.
    """
    if max_bytes is None:
        max_bytes = settings.web_raw_content_cap_bytes
    if max_tokens is None:
        max_tokens = settings.web_cleanup_token_cap

    # Apply noise patterns
    for pattern in _NOISE_PATTERNS:
        text = pattern.sub("", text)

    # Remove very short noise lines
    text = _SHORT_NOISE_LINE.sub("", text)

    # Collapse excessive blank lines
    text = _BLANK_LINES.sub("\n\n", text)

    # Strip leading/trailing whitespace
    text = text.strip()

    # Hard cap: byte limit
    if len(text.encode("utf-8")) > max_bytes:
        text = text.encode("utf-8")[:max_bytes].decode("utf-8", errors="ignore")

    # Hard cap: rough token limit (using ~4 chars per token heuristic)
    char_limit = max_tokens * 4
    if len(text) > char_limit:
        # Try to cut at a paragraph boundary
        cutoff = text.rfind("\n\n", 0, char_limit)
        if cutoff < char_limit * 0.5:
            cutoff = text.rfind("\n", 0, char_limit)
        if cutoff < char_limit * 0.5:
            cutoff = char_limit
        text = text[:cutoff]

    return text


def format_web_result_markdown(
    title: Optional[str],
    content: str,
    url: str = "",
    include_citations: bool = True,
) -> str:
    """Format a web result into the standard agent-reading markdown structure."""
    parts = []

    # Title
    if title:
        parts.append(f"# {title}")
    else:
        parts.append("# Web Result")

    parts.append("")
    parts.append(content)

    # Citations footer
    if include_citations and url:
        parts.append("")
        parts.append("## Citations")
        parts.append(f"- {url}")

    return "\n".join(parts)


def format_kb_result_markdown(
    title: Optional[str],
    chunk_id: int,
    content: str,
    source_uri: Optional[str] = None,
) -> str:
    """Format a KB chunk result into agent-reading markdown."""
    parts = []

    heading = title or "Document"
    parts.append(f"## {heading} — chunk {chunk_id}")
    parts.append("")
    parts.append(content)

    if source_uri:
        parts.append("")
        parts.append(f"*Source: {source_uri}*")

    return "\n".join(parts)

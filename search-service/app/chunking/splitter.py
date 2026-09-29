"""
Token-aware text chunking for KB ingestion.
800 tokens per chunk, 150 token overlap, prefers heading/paragraph boundaries.
Tables (HTML or Markdown) and code blocks are treated as atomic units.
HTML tables are converted to Markdown before chunking — zero HTML in output.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from html.parser import HTMLParser

import tiktoken

from app.config import settings

# Use cl100k_base tokenizer (GPT-4 / general purpose)
_encoder = tiktoken.get_encoding("cl100k_base")


@dataclass
class Chunk:
    """A single text chunk produced by the splitter."""

    chunk_id: int
    text: str
    token_count: int


# ── HTML → Markdown table conversion ────────────────────────────────────────


class _TableParser(HTMLParser):
    """Minimal HTML table parser — extracts rows/cells including colspan."""

    def __init__(self):
        super().__init__()
        self.caption: str = ""
        self.rows: list[list[str]] = []
        self._current_row: list[str] = []
        self._current_cell: list[str] = []
        self._in_cell: bool = False
        self._in_caption: bool = False
        self._current_colspan: int = 1

    def handle_starttag(self, tag, attrs):
        attrs_dict = dict(attrs)
        if tag == "caption":
            self._in_caption = True
        elif tag == "tr":
            self._current_row = []
        elif tag in ("td", "th"):
            self._in_cell = True
            self._current_cell = []
            try:
                self._current_colspan = int(attrs_dict.get("colspan", 1))
            except ValueError:
                self._current_colspan = 1

    def handle_endtag(self, tag):
        if tag == "caption":
            self._in_caption = False
        elif tag == "tr":
            if self._current_row:
                self.rows.append(self._current_row)
        elif tag in ("td", "th"):
            cell_text = " ".join(self._current_cell).strip()
            for _ in range(self._current_colspan):
                self._current_row.append(cell_text)
            self._in_cell = False

    def handle_data(self, data):
        if self._in_caption:
            self.caption += data
        elif self._in_cell:
            stripped = data.strip()
            if stripped:
                self._current_cell.append(stripped)


def _html_table_to_markdown(table_html: str) -> str:
    """Convert a single <table>...</table> HTML block to Markdown."""
    parser = _TableParser()
    try:
        parser.feed(table_html)
    except Exception:
        # Fallback: strip all tags
        return re.sub(r"<[^>]+>", " ", table_html).strip()

    rows = parser.rows
    caption = parser.caption.strip()

    if not rows:
        return ""

    max_cols = max((len(r) for r in rows), default=0)
    if max_cols == 0:
        return ""

    # Single-column layout table → plain paragraphs
    if max_cols <= 1:
        text = "\n\n".join(r[0] for r in rows if r and r[0])
        return f"**{caption}**\n\n{text}" if caption else text

    # Normalise widths
    normalized = [r + [""] * (max_cols - len(r)) for r in rows]

    lines = []
    if caption:
        lines.append(f"**{caption}**\n")
    lines.append("| " + " | ".join(normalized[0]) + " |")
    lines.append("| " + " | ".join("---" for _ in normalized[0]) + " |")
    for row in normalized[1:]:
        lines.append("| " + " | ".join(row) + " |")

    return "\n".join(lines)


def convert_all_html_tables_to_markdown(text: str) -> str:
    """Replace every <table>...</table> block in text with a Markdown table.
    Zero HTML tags remain in the output."""
    if not text or "<table" not in text.lower():
        return text

    def _replace(m: re.Match) -> str:
        try:
            md = _html_table_to_markdown(m.group(0))
            return f"\n\n{md}\n\n" if md else "\n"
        except Exception:
            return "\n"

    result = re.sub(r"<table[\s\S]*?</table>", _replace, text, flags=re.IGNORECASE)

    # Strip any residual HTML tags (belt-and-braces)
    result = re.sub(r"<[a-zA-Z][^>]*>", "", result)
    result = re.sub(r"</[a-zA-Z]+>", "", result)

    return result


# ── Main chunking logic ──────────────────────────────────────────────────────


def chunk_text(  # noqa: C901, PLR0912
    text: str,
    chunk_size: int | None = None,
    chunk_overlap: int | None = None,
) -> list[Chunk]:
    """
    Split text into token-aware chunks with overlap.
    Prefers splitting at heading or paragraph boundaries.
    HTML tables are converted to Markdown before chunking.
    """
    if chunk_size is None:
        chunk_size = settings.chunk_size_tokens
    if chunk_overlap is None:
        chunk_overlap = settings.chunk_overlap_tokens

    if not text.strip():
        return []

    # Phase 0: Convert HTML tables → Markdown (zero HTML in output)
    text = convert_all_html_tables_to_markdown(text)

    # Strip Azure DI structural comments if present
    text = re.sub(
        r"<!--\s*Page(?:Break|Header|Footer|Number)[^>]*-->",
        "\n",
        text,
        flags=re.IGNORECASE,
    )
    text = re.sub(r":(?:selected|unselected):", "", text)
    text = re.sub(r"^:figure\w*:\s*$", "", text, flags=re.MULTILINE)

    # Split into natural sections first (paragraphs / headings)
    sections = _split_into_sections(text)

    chunks: list[Chunk] = []
    current_tokens: list[int] = []
    current_text_parts: list[str] = []
    chunk_id = 0

    for section in sections:
        section_tokens = _encoder.encode(section)

        # If this single section exceeds chunk_size, split it further
        if len(section_tokens) > chunk_size:
            # Flush current buffer first
            if current_tokens:
                chunk_text_str = "".join(current_text_parts).strip()
                if chunk_text_str:
                    chunks.append(
                        Chunk(
                            chunk_id=chunk_id,
                            text=chunk_text_str,
                            token_count=len(current_tokens),
                        )
                    )
                    chunk_id += 1
                # Keep overlap
                current_tokens, current_text_parts = _keep_overlap(
                    current_tokens, current_text_parts, chunk_overlap
                )

            # Split the long section by sentences
            sub_parts = _split_long_section(section, chunk_size, chunk_overlap)
            for sp in sub_parts:
                sp_tokens = _encoder.encode(sp)
                chunks.append(
                    Chunk(
                        chunk_id=chunk_id, text=sp.strip(), token_count=len(sp_tokens)
                    )
                )
                chunk_id += 1

            current_tokens = []
            current_text_parts = []
            continue

        # Check if adding this section exceeds chunk_size
        if len(current_tokens) + len(section_tokens) > chunk_size:
            # Flush current chunk
            chunk_text_str = "".join(current_text_parts).strip()
            if chunk_text_str:
                chunks.append(
                    Chunk(
                        chunk_id=chunk_id,
                        text=chunk_text_str,
                        token_count=len(current_tokens),
                    )
                )
                chunk_id += 1

            # Keep overlap
            current_tokens, current_text_parts = _keep_overlap(
                current_tokens, current_text_parts, chunk_overlap
            )

        current_tokens.extend(section_tokens)
        current_text_parts.append(section)

    # Final chunk
    if current_tokens:
        chunk_text_str = "".join(current_text_parts).strip()
        if chunk_text_str:
            chunks.append(
                Chunk(
                    chunk_id=chunk_id,
                    text=chunk_text_str,
                    token_count=len(current_tokens),
                )
            )

    # Discard tiny chunks that add noise without useful context
    MIN_TOKENS = 30
    chunks = [c for c in chunks if c.token_count >= MIN_TOKENS]
    # Re-number chunk IDs after filtering
    for i, c in enumerate(chunks):
        c.chunk_id = i

    return chunks


def _split_into_sections(text: str) -> list[str]:
    """
    Split text at heading and paragraph boundaries.
    Each section retains its trailing newlines.
    """
    # Split on markdown headings or double newlines
    parts = re.split(r"((?:^|\n)#{1,6}\s.+\n|(?:\n\n)+)", text)
    # Recombine so heading stays with its content
    sections: list[str] = []
    for part in parts:
        if not part:
            continue
        if part.strip():
            sections.append(part)
    return sections if sections else [text]


def _keep_overlap(
    tokens: list[int],
    text_parts: list[str],
    overlap: int,
) -> tuple[list[int], list[str]]:
    """Return the last `overlap` tokens worth of content for overlap."""
    if overlap <= 0 or not tokens:
        return [], []

    # Take last overlap tokens
    overlap_tokens = tokens[-overlap:]
    # Decode them back to text
    overlap_text = _encoder.decode(overlap_tokens)
    return overlap_tokens, [overlap_text]


def _split_long_section(text: str, chunk_size: int, chunk_overlap: int) -> list[str]:
    """Split a section that exceeds chunk_size by sentence boundaries."""
    sentences = re.split(r"(?<=[.!?])\s+", text)
    parts: list[str] = []
    current: list[str] = []
    current_count = 0

    for sentence in sentences:
        sent_tokens = len(_encoder.encode(sentence))

        if current_count + sent_tokens > chunk_size and current:
            parts.append(" ".join(current))
            # `tokens[-0:]` is the whole list, so zero overlap needs its own branch.
            overlap_text = (
                _encoder.decode(_encoder.encode(" ".join(current))[-chunk_overlap:])
                if chunk_overlap > 0
                else ""
            )
            current = [overlap_text, sentence] if overlap_text else [sentence]
            current_count = len(_encoder.encode(" ".join(current)))
        else:
            current.append(sentence)
            current_count += sent_tokens

    if current:
        parts.append(" ".join(current))

    return parts if parts else [text]

"""Chunk boundaries, overlap and the table/comment clean-up of the KB splitter.

Every test swaps in a one-token-per-character encoder, so token counts are
character counts and the expectations can be checked by hand.
Run: pytest search-service/tests
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

pytest.importorskip("pydantic_settings")
from fakes import CharEncoding  # noqa: E402

from app.chunking import splitter  # noqa: E402
from app.chunking.splitter import (  # noqa: E402
    _html_table_to_markdown,
    _keep_overlap,
    _split_into_sections,
    _split_long_section,
    chunk_text,
    convert_all_html_tables_to_markdown,
)


@pytest.fixture(autouse=True)
def char_tokens(monkeypatch):
    monkeypatch.setattr(splitter, "_encoder", CharEncoding())


def para(letter: str, width: int) -> str:
    """A paragraph of ``width`` characters made of one letter."""
    return letter * width


# ── chunk_text ───────────────────────────────────────────────────────


def test_blank_input_yields_nothing():
    assert chunk_text("") == []
    assert chunk_text("   \n\n  ") == []


def test_a_chunk_under_thirty_tokens_is_dropped_as_noise():
    assert chunk_text("tiny", chunk_size=100, chunk_overlap=0) == []


def test_paragraphs_that_fit_together_share_a_chunk():
    # The paragraph separator itself is not a section, so it is not kept.
    text = para("a", 40) + "\n\n" + para("b", 40)
    chunks = chunk_text(text, chunk_size=200, chunk_overlap=0)
    assert len(chunks) == 1
    assert chunks[0].text == para("a", 40) + para("b", 40)
    assert chunks[0].chunk_id == 0


def test_a_paragraph_that_would_overflow_starts_the_next_chunk():
    text = para("a", 40) + "\n\n" + para("b", 40)
    chunks = chunk_text(text, chunk_size=50, chunk_overlap=0)
    assert [c.text for c in chunks] == [para("a", 40), para("b", 40)]
    assert [c.chunk_id for c in chunks] == [0, 1]
    assert all(c.token_count <= 50 for c in chunks)


def test_overlap_repeats_the_tail_of_the_previous_chunk():
    text = para("a", 40) + "\n\n" + para("b", 40)
    chunks = chunk_text(text, chunk_size=60, chunk_overlap=10)
    assert len(chunks) == 2
    # The last ten tokens of the flushed buffer are carried over.
    assert chunks[1].text.startswith(para("a", 10) + para("b", 1))
    assert chunks[1].text.endswith(para("b", 40))
    assert chunks[1].token_count == 50


def test_no_overlap_when_the_setting_is_zero_or_the_buffer_empty():
    assert _keep_overlap([1, 2, 3], ["abc"], 0) == ([], [])
    assert _keep_overlap([], [], 10) == ([], [])
    tokens, parts = _keep_overlap([ord(c) for c in "hello world"], ["hello world"], 5)
    assert parts == ["world"] and len(tokens) == 5


def test_a_section_longer_than_a_chunk_is_split_at_sentences():
    sentences = ["Sentence number %d ends here." % i for i in range(1, 9)]
    text = " ".join(sentences)  # one section, ~240 characters
    chunks = chunk_text(text, chunk_size=100, chunk_overlap=0)
    assert len(chunks) > 1
    for c in chunks:
        assert c.token_count <= 100
        assert c.text.endswith("here.")
    # Zero overlap means every sentence appears exactly once.
    assert sum(c.text.count("ends here.") for c in chunks) == 8


def test_long_section_overlap_carries_the_previous_tail():
    sentences = ["Sentence number %d ends here." % i for i in range(1, 9)]
    parts = _split_long_section(" ".join(sentences), chunk_size=100, chunk_overlap=12)
    assert len(parts) > 1
    assert parts[1].startswith(parts[0][-12:])


def test_a_short_buffer_is_flushed_before_a_long_section():
    short = para("a", 35)
    long_section = " ".join("Sentence number %d ends here." % i for i in range(1, 9))
    chunks = chunk_text(short + "\n\n" + long_section, chunk_size=100, chunk_overlap=0)
    assert chunks[0].text == short
    assert all(c.token_count <= 100 for c in chunks)


def test_chunk_ids_are_renumbered_after_tiny_chunks_are_dropped():
    # The middle paragraph is too small to survive; the ids must stay dense.
    text = para("a", 40) + "\n\n" + "tiny" + "\n\n" + para("b", 40)
    chunks = chunk_text(text, chunk_size=45, chunk_overlap=0)
    assert [c.chunk_id for c in chunks] == list(range(len(chunks)))
    assert all(c.token_count >= 30 for c in chunks)


def test_azure_document_intelligence_markers_are_stripped():
    text = (
        para("a", 40)
        + "\n<!-- PageBreak -->\n"
        + ":selected: yes :unselected: no\n"
        + ":figure1:\n"
        + para("b", 40)
    )
    chunks = chunk_text(text, chunk_size=500, chunk_overlap=0)
    joined = " ".join(c.text for c in chunks)
    assert "PageBreak" not in joined
    assert ":selected:" not in joined and ":unselected:" not in joined
    assert ":figure1:" not in joined
    assert "yes" in joined and "no" in joined


def test_defaults_come_from_settings(monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings, "chunk_size_tokens", 50)
    monkeypatch.setattr(settings, "chunk_overlap_tokens", 0)
    text = para("a", 40) + "\n\n" + para("b", 40)
    assert len(chunk_text(text)) == 2


# ── sections ─────────────────────────────────────────────────────────


def test_headings_stay_attached_to_their_content():
    text = "# Title\nBody one.\n\n## Sub\nBody two."
    sections = _split_into_sections(text)
    assert any(s.startswith("# Title") for s in sections)
    assert any("Body two." in s for s in sections)
    assert all(s.strip() for s in sections)


def test_text_without_boundaries_is_one_section():
    assert _split_into_sections("just one line") == ["just one line"]


# ── HTML tables ──────────────────────────────────────────────────────


def test_a_table_becomes_markdown():
    html = (
        "<table><caption>Prices</caption>"
        "<tr><th>Item</th><th>Cost</th></tr>"
        "<tr><td>Pen</td><td>1</td></tr></table>"
    )
    md = _html_table_to_markdown(html)
    assert md.splitlines() == [
        "**Prices**",
        "",
        "| Item | Cost |",
        "| --- | --- |",
        "| Pen | 1 |",
    ]


def test_colspan_widens_a_cell_and_short_rows_are_padded():
    html = "<table><tr><td colspan='2'>wide</td></tr><tr><td>a</td></tr></table>"
    md = _html_table_to_markdown(html)
    assert "| wide | wide |" in md
    assert "| a |  |" in md


def test_a_single_column_table_reads_as_paragraphs():
    html = "<table><tr><td>first</td></tr><tr><td>second</td></tr></table>"
    assert _html_table_to_markdown(html) == "first\n\nsecond"


def test_an_empty_table_is_dropped():
    assert _html_table_to_markdown("<table></table>") == ""


def test_conversion_leaves_no_html_behind():
    text = "Before <b>bold</b>\n<table><tr><td>x</td><td>y</td></tr></table>\nAfter"
    out = convert_all_html_tables_to_markdown(text)
    assert "<" not in out and ">" not in out
    assert "| x | y |" in out
    assert "Before bold" in out and "After" in out


def test_text_without_a_table_is_returned_untouched():
    text = "no <em>tables</em> here"
    assert convert_all_html_tables_to_markdown(text) is text

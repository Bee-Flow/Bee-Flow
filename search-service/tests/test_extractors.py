"""The pure parts of the extractors: markdown normalisation and formatting,
the HTML title/lang readers, the extraction fallback chain and the PDF
heading heuristics — the last two against fake trafilatura and fitz.
Run: pytest search-service/tests
"""

import os
import sys
import types

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

pytest.importorskip("pydantic_settings")

from app.extractors import pdf  # noqa: E402
from app.extractors.normalizer import (  # noqa: E402
    format_kb_result_markdown,
    format_web_result_markdown,
    normalize_markdown,
)

trafilatura = pytest.importorskip("trafilatura")
from app.extractors import web  # noqa: E402

# ── normalizer ───────────────────────────────────────────────────────


def test_web_noise_lines_are_removed():
    text = (
        "We use cookies to improve your experience\n"
        "Real paragraph one.\n"
        "Subscribe to our newsletter today\n"
        "Home > Products > Widgets\n"
        "Share this on Twitter\n"
        "All rights reserved 2026\n"
        "Real paragraph two.\n"
    )
    out = normalize_markdown(text, max_bytes=10_000, max_tokens=10_000)
    assert "Real paragraph one." in out and "Real paragraph two." in out
    for noise in ("cookies", "newsletter", "Home >", "Share this", "rights reserved"):
        assert noise not in out


def test_blank_lines_collapse_and_short_noise_lines_go():
    out = normalize_markdown(
        "a\n\n\n\n\nb\n--\n***\nc", max_bytes=10_000, max_tokens=10_000
    )
    assert "\n\n\n" not in out
    assert "--" not in out and "***" not in out
    assert out.startswith("a") and out.endswith("c")


def test_the_byte_cap_never_cuts_a_multibyte_character_in_half():
    text = "é" * 100  # two bytes each
    out = normalize_markdown(text, max_bytes=15, max_tokens=10_000)
    assert out == "é" * 7
    out.encode("utf-8")  # still valid text


def test_the_token_cap_prefers_a_paragraph_boundary():
    text = "p" * 100 + "\n\n" + "q" * 100 + "\n\n" + "r" * 100
    # 60 tokens * 4 chars = 240 char limit; the last "\n\n" before it is at 202.
    out = normalize_markdown(text, max_bytes=10_000, max_tokens=60)
    assert out == "p" * 100 + "\n\n" + "q" * 100


def test_the_token_cap_falls_back_to_a_hard_cut_without_boundaries():
    out = normalize_markdown("x" * 1000, max_bytes=10_000, max_tokens=10)
    assert len(out) == 40


def test_web_result_markdown_shape():
    md = format_web_result_markdown("Title", "body", url="https://x.example")
    assert md == "# Title\n\nbody\n\n## Citations\n- https://x.example"
    assert format_web_result_markdown(None, "body", include_citations=False) == (
        "# Web Result\n\nbody"
    )


def test_kb_result_markdown_shape():
    md = format_kb_result_markdown("Doc", 3, "content", source_uri="s3://a")
    assert md == "## Doc — chunk 3\n\ncontent\n\n*Source: s3://a*"
    assert format_kb_result_markdown(None, 0, "c") == "## Document — chunk 0\n\nc"


# ── web extractor ────────────────────────────────────────────────────


def test_html_title_and_lang_readers():
    html = '<html lang="NL-nl"><head><title> Hello  </title></head></html>'
    assert web._extract_html_title(html) == "Hello"
    assert web._extract_html_lang(html) == "nl-nl"
    assert web._extract_html_title("<html></html>") is None
    assert web._extract_html_lang("<html></html>") is None


def test_trafilatura_result_takes_the_title_from_its_xml(monkeypatch):
    def fake_extract(html, output_format="txt", **kwargs):
        if output_format == "xml":
            return '<doc title="From XML" />'
        return "the body text"

    monkeypatch.setattr(trafilatura, "extract", fake_extract)
    result = web._trafilatura_extract('<html lang="de"></html>', "https://x.example")
    assert (result.text, result.title, result.lang, result.method) == (
        "the body text",
        "From XML",
        "de",
        "trafilatura",
    )


def test_trafilatura_falls_back_to_the_html_title(monkeypatch):
    monkeypatch.setattr(
        trafilatura, "extract", lambda html, output_format="txt", **kw: "body"
    )
    result = web._trafilatura_extract("<title>HTML title</title>", "")
    assert result.title == "HTML title"


def test_trafilatura_returning_nothing_is_none(monkeypatch):
    monkeypatch.setattr(trafilatura, "extract", lambda *a, **kw: None)
    assert web._trafilatura_extract("<html></html>", "") is None


def test_extract_content_falls_through_to_readability(monkeypatch):
    long_text = "x" * 200
    monkeypatch.setattr(web, "_trafilatura_extract", lambda html, url: None)
    monkeypatch.setattr(
        web,
        "_readability_extract",
        lambda html, url: web.ExtractionResult(text=long_text, method="readability"),
    )
    assert web.extract_content("<html/>", "u").method == "readability"


def test_extract_content_rejects_short_results_from_both(monkeypatch):
    short = web.ExtractionResult(text="too short")
    monkeypatch.setattr(web, "_trafilatura_extract", lambda html, url: short)
    monkeypatch.setattr(web, "_readability_extract", lambda html, url: short)
    assert web.extract_content("<html/>", "u") is None


def test_readability_is_skipped_when_not_installed(monkeypatch):
    monkeypatch.setattr(web, "HAS_READABILITY", False)
    assert web._readability_extract("<html/>", "u") is None


# ── pdf extractor ────────────────────────────────────────────────────


class FakePage:
    def __init__(self, lines, text="some text"):
        self._lines = lines
        self._text = text

    def get_text(self, kind=None, flags=None):
        if kind == "dict":
            return {
                "blocks": [
                    {
                        "type": 0,
                        "lines": [
                            {"spans": [{"text": t, "size": size}]}
                            for t, size in self._lines
                        ],
                    },
                    {"type": 1},
                ]
            }
        return self._text


class FakeDoc:
    def __init__(self, pages, metadata=None):
        self._pages = pages
        self.metadata = metadata or {}
        self.page_count = len(pages)
        self.closed = False

    def load_page(self, i):
        return self._pages[i]

    def close(self):
        self.closed = True


def _fake_fitz(doc):
    return types.SimpleNamespace(
        open=lambda stream=None, filetype=None: doc, TEXTFLAGS_TEXT=0
    )


def test_without_either_library_extraction_is_empty(monkeypatch):
    monkeypatch.setattr(pdf, "HAS_PYMUPDF", False)
    monkeypatch.setattr(pdf, "HAS_PYPDF", False)
    assert pdf.extract_pdf_text(b"%PDF") == ""
    assert pdf.has_extractable_text(b"%PDF") is True


def test_large_fonts_become_subheadings(monkeypatch):
    doc = FakeDoc(
        [FakePage([("Chapter One", 18.0), ("Body line.", 11.0), ("", 20.0)])],
        metadata={"title": "Meta Title"},
    )
    monkeypatch.setattr(pdf, "HAS_PYMUPDF", True)
    monkeypatch.setattr(pdf, "fitz", _fake_fitz(doc), raising=False)

    text = pdf._pymupdf_extract(b"%PDF")

    assert text.splitlines() == [
        "# Meta Title",
        "",
        "## Page 1",
        "",
        "### Chapter One",
        "Body line.",
    ]
    assert doc.closed


def test_an_explicit_title_wins_and_a_long_big_line_is_body(monkeypatch):
    doc = FakeDoc([FakePage([("L" * 250, 18.0)])])
    monkeypatch.setattr(pdf, "HAS_PYMUPDF", True)
    monkeypatch.setattr(pdf, "fitz", _fake_fitz(doc), raising=False)
    text = pdf._pymupdf_extract(b"%PDF", title="Given")
    assert text.startswith("# Given\n")
    assert "### " not in text


def test_no_title_anywhere_reads_document(monkeypatch):
    doc = FakeDoc([FakePage([("x", 10.0)])])
    monkeypatch.setattr(pdf, "HAS_PYMUPDF", True)
    monkeypatch.setattr(pdf, "fitz", _fake_fitz(doc), raising=False)
    assert pdf._pymupdf_extract(b"%PDF").startswith("# Document\n")


def test_scanned_pages_report_no_extractable_text(monkeypatch):
    monkeypatch.setattr(pdf, "HAS_PYMUPDF", True)
    scanned = FakeDoc([FakePage([], text=" "), FakePage([], text="")])
    monkeypatch.setattr(pdf, "fitz", _fake_fitz(scanned), raising=False)
    assert pdf.has_extractable_text(b"%PDF") is False
    real = FakeDoc([FakePage([], text="w" * 100)])
    monkeypatch.setattr(pdf, "fitz", _fake_fitz(real), raising=False)
    assert pdf.has_extractable_text(b"%PDF") is True


def test_pypdf_fallback_skips_empty_pages(monkeypatch):
    class FakeReader:
        def __init__(self, stream):
            self.metadata = types.SimpleNamespace(title="Reader Title")
            self.pages = [
                types.SimpleNamespace(extract_text=lambda: "  first  "),
                types.SimpleNamespace(extract_text=lambda: "   "),
            ]

    monkeypatch.setattr(pdf, "HAS_PYPDF", True)
    monkeypatch.setattr(pdf, "PdfReader", FakeReader, raising=False)
    assert pdf._pypdf_extract(b"%PDF") == "# Reader Title\n\n## Page 1\n\nfirst"


def test_extract_pdf_text_prefers_pymupdf_then_pypdf(monkeypatch):
    monkeypatch.setattr(pdf, "_pymupdf_extract", lambda b, t=None: "short")
    monkeypatch.setattr(pdf, "_pypdf_extract", lambda b, t=None: "y" * 80)
    assert pdf.extract_pdf_text(b"%PDF") == "y" * 80

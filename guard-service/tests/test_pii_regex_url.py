"""The URL pattern ends where the address ends.

The body used to be ``\\S+``: in a compact JSON tool result the match ran over
the closing quote into the next array element, the overlap resolver merged it
with the name there, and one ``[url_1]`` token swallowed two values of a sheet
row. These tests pin where a match stops. All data is fictional.

    python -m unittest tests.test_pii_regex_url
"""

from __future__ import annotations

import unittest

from app.services.pii_regex import detect_regex_pii
from app.services.pii_regex.generic import _URL_RE


def _urls(text: str) -> list[str]:
    return [
        e["text"]
        for e in detect_regex_pii(text, enabled_categories={"URL"})
        if e["category"] == "URL"
    ]


class UrlEndsAtJsonQuoteTests(unittest.TestCase):
    def test_a_compact_json_row_yields_only_the_address(self):
        row = (
            '{"values":[["#00022","Acme B.V.","Accountants",'
            '"http://example.nl","Jan Jansen"]],"rowCount":1}'
        )
        self.assertEqual(_urls(row), ["http://example.nl"])

    def test_the_last_value_of_a_row_does_not_take_the_closing_brackets(self):
        tail = '"http://example.nl"]],"rowCount":1}'
        found = _urls(tail)
        self.assertEqual(found, ["http://example.nl"])
        self.assertNotIn('"]]', found[0])

    def test_the_www_form_stops_at_the_quote_too(self):
        self.assertEqual(
            _urls('["www.example.nl/contact","Jan Jansen"]'),
            ["www.example.nl/contact"],
        )

    def test_characters_a_url_cannot_hold_unescaped_end_the_match(self):
        for stop in ("'", "<", ">", "\\", "^", "`", "{", "}", "|", " ", "\t", "\n"):
            with self.subTest(stop=stop):
                text = f"zie https://example.nl/a{stop}b"
                self.assertEqual(_urls(text), ["https://example.nl/a"])


class UrlTrailingPunctuationTests(unittest.TestCase):
    def test_sentence_punctuation_after_a_url_is_not_part_of_it(self):
        for tail in (".", ",", ";", ":", "!", "?", ")", "]", ")."):
            with self.subTest(tail=tail):
                text = f"Kijk op https://example.nl/pad{tail} voor meer."
                self.assertEqual(_urls(text), ["https://example.nl/pad"])

    def test_a_url_in_brackets(self):
        self.assertEqual(_urls("(zie https://example.nl)"), ["https://example.nl"])
        self.assertEqual(_urls("(zie www.example.nl)."), ["www.example.nl"])

    def test_punctuation_inside_the_url_stays(self):
        text = "https://example.nl/a.b/c,d;e:f?g=1&h=(2)#x!y end"
        self.assertEqual(_urls(text), ["https://example.nl/a.b/c,d;e:f?g=1&h=(2)#x!y"])

    def test_a_bare_scheme_is_no_url(self):
        self.assertEqual(_urls("http://. en https:// alleen"), [])


class UrlExistingShapesTests(unittest.TestCase):
    def test_plain_urls_still_match_whole(self):
        cases = {
            "Zie https://www.example.nl/pad/naar?q=1&r=2#anker voor info": (
                "https://www.example.nl/pad/naar?q=1&r=2#anker"
            ),
            "Bezoek www.example.nl vandaag": "www.example.nl",
            "Bezoek www.example.nl/pad/x vandaag": "www.example.nl/pad/x",
            "Link: http://example.nl:8080/a%20b": "http://example.nl:8080/a%20b",
            "Link: https://example.nl/~jan/[1]/x": "https://example.nl/~jan/[1]/x",
        }
        for text, url in cases.items():
            with self.subTest(text=text):
                self.assertEqual(_urls(text), [url])

    def test_two_urls_in_one_line(self):
        self.assertEqual(
            _urls("https://a.example.nl, https://b.example.nl."),
            ["https://a.example.nl", "https://b.example.nl"],
        )

    def test_linear_on_a_long_run_of_punctuation(self):
        # A failing tail must not backtrack quadratically.
        text = "http://" + "." * 50_000 + " " + "www.example." + "a" * 50_000
        self.assertIsNotNone(_URL_RE.search(text))


if __name__ == "__main__":
    unittest.main()

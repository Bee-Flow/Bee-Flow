"""Belgium: the rijksregisternummer (dotted and bare), VAT and plates.

The dotted form is unmistakable; the bare eleven digits are not, so they
need a keyword nearby. The mod-97 check accepts both century branches.
"""

from __future__ import annotations

import re

from .anchors import _ANCHOR_GAP, _NATID_ANCHOR_WORDS

_BE_NATID_DOTTED_RE = re.compile(r"\b\d{2}\.\d{2}\.\d{2}-\d{3}\.\d{2}\b")
_BE_NATID_BARE_RE = re.compile(r"\b\d{11}\b")
_BE_NATID_ANCHOR_RE = re.compile(
    r"\b(?:rijksregisternummer|rijksregister|numéro\s+national|INSZ|NISS|"
    + _NATID_ANCHOR_WORDS
    + r")"
    + _ANCHOR_GAP,
    re.IGNORECASE,
)
_BE_VAT_RE = re.compile(r"\bBE\s?0\d{9}\b")
# Current Belgian series: one leading digit, three letters, three digits.
_BE_PLATE_RE = re.compile(r"\b[12]-[A-Z]{3}-\d{3}\b")


def _is_valid_be_national_id(candidate: str) -> bool:
    """Belgian rijksregisternummer — mod-97 over the first nine digits.

    Both century branches are accepted because the number itself does not say
    which one it is: post-2000 births prefix a `2` before the modulo.
    """
    d = "".join(c for c in candidate if c.isdigit())
    if len(d) != 11:
        return False
    body, check = d[:9], int(d[9:])
    return check in (97 - int(body) % 97, 97 - int("2" + body) % 97)

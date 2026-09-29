"""The context-anchor vocabulary shared by the country modules.

``_ANCHOR_GAP`` is what may sit between a keyword and its value; the three word
groups are the multilingual keyword alternations an anchored pattern is built
from. Every anchor regex in this package ends in ``_ANCHOR_GAP``.
``_LINE_SPACE`` is the whitespace a VALUE may contain.
"""

from __future__ import annotations

# ── Whitespace inside a value ───────────────────────────────────────────
# A space, a no-break space and a narrow no-break space: the whitespace that
# can sit INSIDE one value. Patterns use this instead of `\s`, which also
# matches `\n` and `\t`, so a match could run on into the next line or the next
# table cell and one token would swallow two cells (BFSF-299).
_LINE_SPACE_CHARS = " \u00a0\u202f"
_LINE_SPACE = f"[{_LINE_SPACE_CHARS}]"

# ── The anchor gap ──────────────────────────────────────────────────────
# What may sit between an anchor keyword and the value it anchors. _scan looks
# back 40 characters and requires the keyword to end within this gap.
#
# This was `[\s:#\-]{0,10}` — separators only. That meant the keyword had to be
# effectively adjacent, so "BSN: 123456789" anchored but "Het BSN is
# 123456789" did not, and neither did "Het BSN in dit dossier luidt …". Those
# are not edge cases; they are how people write. Measured on the corpus, every
# single missed Polish PESEL and Austrian SVNR was a value with its keyword
# present but one prose word too far away — recall 0.214 and 0.500 for
# detectors that were working exactly as designed.
#
# The rule is now "up to 25 characters, none of them a digit". Excluding digits
# is what keeps it honest: it stops a keyword reaching PAST one number to claim
# a different one, which is the false positive this constraint exists to
# prevent. Length still bounds it, and _scan's 40-character window bounds it
# again. Language-neutral, so it works for the Dutch/English/native anchor
# alternations without a connective-word list per language.
_ANCHOR_GAP = r"[^0-9]{0,25}$"

# ANCHOR LANGUAGE, which is not the same thing as identifier country. A Dutch
# support agent writes "kenteken SD-ZP 1640" about a German plate and
# "burgerservicenummer 72380468275" about a German ID — the text is Dutch, the
# value is foreign. Anchoring German patterns on German keywords only therefore
# missed the common case, which the corpus makes plain: every non-Dutch value in
# it sits in Dutch prose. So each anchor group carries the product's languages
# (Dutch, English) plus the identifier's own.
_NATID_ANCHOR_WORDS = (
    r"burgerservicenummer|bsn|sofinummer|persoonsnummer|identificatienummer|"
    r"nationaal\s+nummer|national\s+(?:id|identification|insurance)\s*(?:number)?|"
    r"social\s+security|personal\s+id(?:entifier)?"
)
_PLATE_ANCHOR_WORDS = (
    r"kenteken(?:plaat)?|nummerplaat|licen[cs]e\s+plate|"
    r"registration\s*(?:number|plate)?|plaat"
)
# Health insurance, same multilingual rule as above: a Dutch agent writes
# "polisnummer" about a UK NHS number. Anchoring the NHS spec on English words
# alone left 26 corpus NHS numbers unanchored, where the US phone pattern then
# claimed them — the shape is a 3-3-4 grouped ten-digit run either way, so
# whichever spec fires first wins, and only the surrounding words can settle it.
_HEALTH_INS_ANCHOR_WORDS = (
    r"polisnummer|verzekerings?nummer|verzekerdennummer|zorgverzekeraar|"
    r"zorgverzekering|zorgpolis|zorgnummer|"
    r"NHS(?:\s+number)?|national\s+health\s+service|health\s+authority|"
    r"health\s+services\s+authority|health\s+insurance(?:\s+number)?|"
    r"insurance\s+number|policy\s+number"
)

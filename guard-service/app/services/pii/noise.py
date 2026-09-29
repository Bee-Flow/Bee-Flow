"""The two cheap rejections that keep non-PII out of the result.

``_is_skippable`` answers "can this text contain PII at all" before any model
call; ``_is_noise_person_org`` drops the common-noun Person/Organization spans
fp32 GLiNER is eager about. Both are applied while candidates are collected,
not in post-processing, so neither is subject to the union invariant in
``overlaps``.
"""

from __future__ import annotations

# ── Person/Organization false-positive filter ──────────────────────────
# fp32 GLiNER is eager: it tags common Dutch nouns / pronouns / roles as
# Person or Organization ("ouders", "kinderen", "ik", "school", "bank",
# "notaris", "mediator"). Measured: the noise is lowercase common nouns
# (bank 0.60, school 0.55, ouders <0.25) while every REAL name/org is
# capitalised (Mark van Dalen 0.93 … notaris Van Beek 0.48). So we drop a
# Person/Org span when it (a) is a known common noun, (b) is made up
# entirely of stopwords + surname particles, or (c) contains no uppercase
# letter at all. This preserves real (capitalised) names even at low
# confidence, so we don't have to raise the floor and lose recall.
_PERSON_ORG_STOPWORDS = frozenset(
    {
        "ik",
        "jij",
        "u",
        "wij",
        "hij",
        "zij",
        "ze",
        "we",
        "mij",
        "mijn",
        "hem",
        "haar",
        "hen",
        "hun",
        "je",
        "me",
        "ouder",
        "ouders",
        "kind",
        "kinderen",
        "moeder",
        "vader",
        "zoon",
        "dochter",
        "partner",
        "gezin",
        "familie",
        "mediator",
        "advocaat",
        "notaris",
        "rechter",
        "getuige",
        "makelaar",
        "taxateur",
        "werkgever",
        "werknemer",
        "partij",
        "partijen",
        "client",
        "cliënt",
        "clienten",
        "cliënten",
        "bank",
        "school",
        "woning",
        "huis",
        "kantoor",
        "heer",
        "mevrouw",
        "meneer",
        "mevr",
        "dhr",
        "mw",
        "mr",
        "prof",
        "drs",
        "ir",
        "ing",
    }
)
_STOP_PARTICLES = frozenset(
    {
        "van",
        "de",
        "der",
        "den",
        "ten",
        "ter",
        "te",
        "het",
        "een",
        "'t",
        "of",
        "en",
        "aan",
        "bij",
        "op",
        "in",
        "met",
    }
)


def _is_noise_person_org(text: str) -> bool:
    """True when a Person/Organization span is almost certainly a false hit."""
    raw = (text or "").strip()
    if not raw:
        return True
    low = raw.lower().strip(".,;:!?)('\"’`")
    if not low:
        return True
    if low in _PERSON_ORG_STOPWORDS:
        return True
    tokens = [t for t in low.split() if t]
    # Span is entirely stopwords / particles, e.g. "van de kinderen", "de heer".
    if tokens and all(
        t in _PERSON_ORG_STOPWORDS or t in _STOP_PARTICLES for t in tokens
    ):
        return True
    # A SINGLE all-lowercase token is almost always a common noun ("bank",
    # "school", "schoolactiviteiten"). We deliberately do NOT extend this to
    # multi-token spans: an informal lowercase chat message ("jan jansen")
    # is a real name we must still redact — recall beats precision for a
    # privacy filter, so only the clearest single-word nouns are dropped.
    if len(tokens) == 1 and not any(c.isupper() for c in raw):
        return True
    return False


def _is_skippable(text: str) -> bool:
    """Return True when *text* cannot plausibly contain PII.

    Catches the most common no-op cases: empty / whitespace, short
    acknowledgements ("ja", "ok", "Nee bedankt"), and tokenised-only
    text (e.g. the roundtrip return path where every span has already
    been replaced with ``[token_N]`` placeholders).
    """
    if not text or not text.strip():
        return True

    # Strip whitespace and placeholders, then check if anything alphabetic
    # of length >= 4 remains. PII < 4 chars (e.g. "ada") is too rare to
    # justify running the model.
    import re

    stripped = re.sub(r"\[[a-zA-Z]+_\d+\]", "", text)
    alpha_count = sum(1 for c in stripped if c.isalpha())
    return alpha_count < 4

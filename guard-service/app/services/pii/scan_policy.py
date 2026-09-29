"""What this pod is configured to scan: tier mode, regions, work budget.

Three settings-derived answers the detection path asks on every request —
which detection tiers run, which regions' patterns apply, and how many
characters this pod is willing to spend on one scan. All three deliberately
fail loud or fall back explicitly rather than defaulting silently, because a
misread here reads downstream as "no PII here".
"""

from __future__ import annotations

# ── Detection tier mode ────────────────────────────────────────────────
# See GUARD_PII_REGEX_TIER in app/config.py. `on` is today's two-tier
# behaviour; `shadow` runs both tiers and returns the same union while
# logging the per-category diff; `off` is GLiNER-only.
TIER_MODES: frozenset[str] = frozenset({"on", "shadow", "off"})


def resolve_tier_mode() -> str:
    """Return the configured tier mode, rejecting anything unrecognised.

    Deliberately fails loud rather than defaulting: silently treating a
    typo'd GUARD_PII_REGEX_TIER as `on` would mean an operator who believes
    they cut over to GLiNER-only is actually still running the regex tier
    (or, worse in the other direction, believes they rolled back when they
    did not). Neither misreading is acceptable for a privacy control.
    """
    from app.config import settings

    # Strip BEFORE defaulting. envsubst renders an undefined variable as the
    # empty string, and a manifest template can easily yield a whitespace-only
    # value; both must mean "unset" and fall back to `on`. Defaulting first and
    # stripping second turned "   " into a startup crash — i.e. a deploy-time
    # outage caused by the validation meant to prevent one.
    raw = getattr(settings, "pii_regex_tier", None)
    mode = ("" if raw is None else str(raw)).strip().lower() or "on"
    if mode not in TIER_MODES:
        raise ValueError(
            f"GUARD_PII_REGEX_TIER={mode!r} is not one of {sorted(TIER_MODES)}"
        )
    return mode


# Per-tier work budget in characters, used when GUARD_PII_SCAN_BUDGET_CHARS is
# left at 0. The tier decides the per-char cost: `on` asks GLiNER for ~4 label
# groups (the regex-complete categories are excluded), `shadow` and `off` for
# all 7, and `shadow` additionally pays the regex tier. Measured on production
# under `shadow`: ~4.5ms/char, i.e. 2410 chars in 10.7s.
#
# Sized so a full scan stays far inside the caller's 90s timeout even when it
# queues behind another scan. Above the budget the existing partial-scan path
# returns what it did manage, which is a result the caller can act on — unlike
# the timeout it replaces.
_TIER_SCAN_BUDGET_CHARS: dict[str, int] = {
    "on": 25_000,
    "off": 15_000,
    "shadow": 15_000,
}


def _scan_budget_chars() -> int:
    """Characters this pod is willing to scan in ONE request."""
    from app.config import settings

    explicit = int(getattr(settings, "pii_scan_budget_chars", 0) or 0)
    if explicit > 0:
        budget = explicit
    else:
        try:
            budget = _TIER_SCAN_BUDGET_CHARS[resolve_tier_mode()]
        except ValueError:
            # A bad tier value is the tier resolver's error to raise, at the
            # point where it matters. Do not turn it into an unbounded scan.
            budget = min(_TIER_SCAN_BUDGET_CHARS.values())
    # pii_max_chars remains the outer memory-shaped ceiling; never exceed it.
    return max(1, min(budget, settings.pii_max_chars))


def configured_regions() -> frozenset[str] | None:
    """The pod's default detection regions, or None for "all".

    GUARD_PII_REGIONS is a comma-separated list; blank and `*` both mean all,
    for the same reason resolve_tier_mode() treats blank as the default —
    envsubst renders an undefined manifest variable as the empty string.
    """
    from app.config import settings
    from app.services.pii_regex import normalise_regions

    raw = getattr(settings, "pii_regions", None)
    if raw is None:
        return None
    return normalise_regions(str(raw).split(","))


def _effective_regions(
    enabled_regions: list[str] | None,
) -> frozenset[str] | None:
    """Regions a request will actually be scanned with: its own, else the pod's."""
    from app.services.pii_regex import normalise_regions

    if enabled_regions is not None:
        return normalise_regions(enabled_regions)
    return configured_regions()

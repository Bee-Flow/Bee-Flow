"""Per-category confidence floors and the slider they are anchored to.

A GLiNER score is only meaningful against its own category's floor, so these
numbers are consumed in two places: the acceptance test in ``detection`` and
the margin comparison in ``ranking``. Both read them here rather than carrying
their own copy.
"""

from __future__ import annotations

# ── Per-category confidence floors ─────────────────────────────────────
# GLiNER score distributions differ per category. A flat 0.70 floor
# misses too many Person/Org/Address spans (which cluster 0.45-0.65)
# while letting medical-vocabulary noise through at 0.50. The
# orchestrator queries GLiNER at the *lowest* applicable threshold and
# filters per category in the post-loop.
# RECALIBRATION REMAINS TODO — and the 2026-07-31 attempt is a cautionary
# tale recorded in eval/MODEL-DECISIONS.md: a full calibrate-apply-gate cycle
# was run and reverted before it was discovered that the measurement
# containers had SILENTLY UNMOUNTED volumes (Git-Bash MSYS path mangling
# turned the container-side of `-v` into `C:\Program Files\Git\...`), so both
# the calibration and its "gate" measured the image's baked code and corpus,
# not the working tree. No floor below changed as a result. When recalibrating
# for real: launch measurement containers from PowerShell (or with
# MSYS_NO_PATHCONV=1), verify the mount with a probe file first, and gate in
# HYBRID mode — calibrate.py fits the model-only tier by design, which is not
# the configuration that ships.
_PER_CATEGORY_THRESHOLD: dict[str, float] = {
    # Person floored low (0.40): bare short Dutch first names ("Mark",
    # "Sanne") cluster right around here, and a missed name is the
    # highest-impact PII leak (BFSF-269). The slider can lower this
    # further via _final_floor's anchoring math.
    "Person": 0.40,
    "Organization": 0.50,
    "Address": 0.50,
    "DateOfBirth": 0.55,
    "PassportNumber": 0.60,
    "DriversLicenseNumber": 0.60,
    "BankAccountNumber": 0.55,
    "MedicalCondition": 0.65,
    "Medication": 0.60,
    "HealthInsuranceNumber": 0.60,
    # ── Formerly regex-owned; provisional, pending a VALID recalibration ─
    # These starting values sit just below the measured true-positive floor
    # per category, biased toward recall (a missed entity is a leak, a false
    # positive is a nuisance).
    "PhoneNumber": 0.35,
    "Email": 0.45,
    "URL": 0.55,
    "IPAddress": 0.50,
    "CreditCardNumber": 0.40,
    "InternationalBankingAccountNumber": 0.35,
    "USSocialSecurityNumber": 0.40,
    "LicensePlateNumber": 0.35,
    "TaxIdentificationNumber": 0.55,
    "NationalIdentificationNumber": 0.45,
    # Measured P/R 1.000 at floor 0.54 with "api key" alone; 0.45 leaves
    # headroom for the slider without reaching into the noise band.
    "ApiKeyOrSecret": 0.45,
}

# The UI "Confidence Threshold" slider default. The per-category floors
# above are calibrated *at* this anchor; _final_floor() shifts them by
# (slider − anchor) so dragging toward "Detect more (10%)" genuinely
# widens recall on Person/Org/Address (BFSF-269) and dragging toward
# "Detect less (100%)" tightens precision — while preserving the
# relative tuning between categories.
_UI_DEFAULT_THRESHOLD = 0.70
_ABSOLUTE_FLOOR = 0.10
_ABSOLUTE_CEIL = 0.99

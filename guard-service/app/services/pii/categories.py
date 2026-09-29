"""The PII category vocabulary: GLiNER label in, canonical category out.

Three tables and the two sets derived from them. Everything else in this
package speaks in the canonical category keys defined here — the keys the Node
side (``server/core/privacy/piiDetection``) and the admin picker share — so
this module is the one place a new category enters the service.
"""

from __future__ import annotations

# ── GLiNER label → our category key ────────────────────────────────────
#
# The right-hand side is the canonical category key the Node side knows.
#
# NOTE: this block used to claim GLiNER "expects natural-language labels
# (lowercase)". That is measurably FALSE for this model, and believing it
# costs real recall:
#
#     IBAN                  P 0.950     iban                   P 0.474
#     burgerservicenummer   P 1.000     national id number     P 0.323
#     BSN                   P 0.000  (an acronym that works for one
#                                     category can be dead for another)
#
# Casing and language are per-label empirical facts, not a house style.
# Sweep them (eval/label_groups/) rather than assuming.

GLINER_LABELS_TO_CATEGORY: dict[str, str] = {
    "person": "Person",
    "organization": "Organization",
    "address": "Address",
    "email address": "Email",
    "phone number": "PhoneNumber",
    "date of birth": "DateOfBirth",
    "credit card number": "CreditCardNumber",
    # ── IBAN: use the TRAINED label, and use it alone ──────────────────
    # Both model cards (urchade/gliner_multi_pii-v1 and the E3-JSI fine-tune
    # on synthetic-multi-pii-ner-v1) publish the label vocabulary these
    # weights were trained on. It contains lower-case `iban`. It does NOT
    # contain `IBAN` — that spelling is out-of-vocabulary and the model only
    # answers it zero-shot.
    #
    # Measured (eval/probe_labels.py, calibrate split, floor 0.10, 56 gold):
    #     'iban'                                   R 0.804   P~ 0.298
    #     'IBAN'                                   R 0.518   P~ 0.707
    #     'IBAN' + 'iban'                          R 0.714
    #     'IBAN' + 'iban' + 'credit card number'   R 0.554   <- WAS SHIPPED
    #     'iban' + 'internationaal bankrekeningnummer'  R 0.714
    #
    # So the shipped group lost recall twice over: to an out-of-vocabulary
    # sibling and to `credit card number` (-16pp on its own). The note at the
    # top of this map recorded `IBAN` P 0.950 vs `iban` P 0.474 — that is
    # PRECISION and it still holds directionally; recall was never measured
    # beside it, which is how a 0.02-recall category shipped looking tuned.
    #
    # An invented Dutch label scores well alone but LOWERS recall in
    # combination — do not add out-of-vocabulary labels without re-measuring
    # the group, not just the label.
    "IBAN": "InternationalBankingAccountNumber",
    "iban": "InternationalBankingAccountNumber",
    "social security number": "USSocialSecurityNumber",
    "passport number": "PassportNumber",
    "driver's license number": "DriversLicenseNumber",
    "ip address": "IPAddress",
    "url": "URL",
    "bank account number": "BankAccountNumber",
    # ── Secrets ────────────────────────────────────────────────────────
    # ApiKeyOrSecret had NO GLiNER label at all: it was regex-only, which
    # made it the presumed blocker for the whole cutover. Measured, the
    # model does it perfectly — "api key" alone scores P/R 1.000 on the
    # corpus's 45 gold spans (sk-…, AKIA…) with 100% boundary exactness.
    #
    # ONE label, deliberately. "secret key", "access token" and "password"
    # each also score 1.000 ALONE, but all of them together collapse to
    # P 0.475 — and "credential" alone is P 0.090, a pure noise generator.
    # Do not add more without re-measuring: this category is unusually
    # sensitive to label dilution.
    "api key": "ApiKeyOrSecret",
    # ── EU / Netherlands additions ────────────────────────────────────
    # Multiple natural-language labels collapse to the same canonical ID
    # so prompts like "BSN", "DNI", "codice fiscale" all surface as
    # NationalIdentificationNumber regardless of which phrasing the model
    # tags the span with.
    "burgerservicenummer": "NationalIdentificationNumber",
    "citizen service number": "NationalIdentificationNumber",
    "national id number": "NationalIdentificationNumber",
    "identity card number": "NationalIdentificationNumber",
    "identity document number": "NationalIdentificationNumber",
    "tax identification number": "TaxIdentificationNumber",
    "health insurance id number": "HealthInsuranceNumber",
    "health insurance number": "HealthInsuranceNumber",
    "national health insurance number": "HealthInsuranceNumber",
    "medical condition": "MedicalCondition",
    "medication": "Medication",
    "license plate number": "LicensePlateNumber",
}

CATEGORY_LABELS: dict[str, str] = {
    "Person": "Person Name",
    "Organization": "Organization",
    "Address": "Physical Address",
    "Email": "Email Address",
    "PhoneNumber": "Phone Number",
    "DateOfBirth": "Date of Birth",
    "CreditCardNumber": "Credit Card Number",
    "InternationalBankingAccountNumber": "IBAN",
    "USSocialSecurityNumber": "SSN (US)",
    "PassportNumber": "Passport Number",
    "DriversLicenseNumber": "Driver's License",
    "IPAddress": "IP Address",
    "URL": "URL",
    "BankAccountNumber": "Bank Account Number",
    # Lived only in pii_regex._CATEGORY_LABELS. Without it here, every
    # secret entity would silently report its raw key as its label once the
    # regex tier is gone.
    "ApiKeyOrSecret": "API Key / Secret",
    # EU / Netherlands
    "NationalIdentificationNumber": "National ID",
    "TaxIdentificationNumber": "Tax ID",
    "HealthInsuranceNumber": "Health Insurance Number",
    "MedicalCondition": "Medical Condition",
    "Medication": "Medication",
    "LicensePlateNumber": "License Plate",
}

# ── Category relationships ─────────────────────────────────────────────
# Every canonical category the service can emit. Pinned in tests against
# eval.schema.CANONICAL_CATEGORIES and, through that, the admin picker —
# adding a row to piiCategories.ts without a label here would show admins a
# toggle that silently never fires.
ALL_CATEGORIES: frozenset[str] = frozenset(GLINER_LABELS_TO_CATEGORY.values())

# Categories with a machine-checkable surface form. Two consumers:
#   * span boundary exactness is a SAFETY metric for these (the Node side
#     redacts by splicing offset/length, so a clipped IBAN leaks digits);
#   * they win near-ties in _finalise against fuzzy categories.
STRUCTURED_CATEGORIES: frozenset[str] = frozenset(
    {
        "Email",
        "PhoneNumber",
        "InternationalBankingAccountNumber",
        "CreditCardNumber",
        "IPAddress",
        "URL",
        "NationalIdentificationNumber",
        "USSocialSecurityNumber",
        "LicensePlateNumber",
        "TaxIdentificationNumber",
        "ApiKeyOrSecret",
        "BankAccountNumber",
        "PassportNumber",
        "DriversLicenseNumber",
        "HealthInsuranceNumber",
        "DateOfBirth",
    }
)

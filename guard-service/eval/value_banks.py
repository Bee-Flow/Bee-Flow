"""Locale value banks + validator-backed synthetic PII generators.

Privacy-first rule: NO real personal data lives in this repo. Every value is
synthetic and drawn from documentation/reserved ranges. For the checksum-backed
categories we construct values against the harness's own validators
(eval/validators.py) and assert each generated value passes them — so the corpus
contains genuinely well-formed identifiers while staying provably non-real. If a
generator ever emits a value that fails its checksum it raises immediately.

Note these validators describe the *value*, not any detector: the corpus is
deliberately independent of whatever is doing the detecting, so it can measure a
detector change rather than merely reflect it.

All generators take a ``random.Random`` for seeded reproducibility and return
``(value, value_kind)``. Fuzzy (GLiNER-tier) categories just draw from curated
banks; deterministic categories are constructed + validated.
"""

from __future__ import annotations

import random
import string

# Checksum validators, vendored into the harness (see eval/validators.py).
# These used to be imported from app.services.pii_regex, which made the corpus
# definitionally the set of values that detector was perfect on — a tautology,
# not a measurement. The gold set must be defined independently of any
# detector, and must survive the regex tier's deletion.
from .validators import (
    _is_valid_bsn,
    _is_valid_iban,
    _is_valid_luhn,
    _is_valid_ssn,
    _is_valid_ipv4,
    is_valid_at_svnr,
    is_valid_be_national_id,
    is_valid_es_dni,
    is_valid_fr_nir,
    is_valid_iso7064_mod11_10,
    is_valid_pl_pesel,
    is_valid_se_personnummer,
    is_valid_uk_nhs as _is_valid_uk_nhs,
    is_valid_de_kvnr,
    is_valid_de_rvnr,
)

# ── Fuzzy-category banks (GLiNER tier) ─────────────────────────────────────
# Names: first names + Dutch tussenvoegsels + surnames per locale. Kept small
# but varied; the generator composes full names so co-occurrence is realistic.

_FIRST_NAMES = {
    "nl": [
        "Mark",
        "Sanne",
        "Eva",
        "Tim",
        "Noor",
        "Daan",
        "Lotte",
        "Sven",
        "Fenna",
        "Bram",
        "Julia",
        "Thijs",
        "Anouk",
        "Ruben",
        "Maud",
    ],
    "de": ["Lukas", "Anna", "Felix", "Lena", "Jonas", "Marie", "Paul", "Laura"],
    "fr": ["Louis", "Emma", "Hugo", "Léa", "Jules", "Chloé", "Nathan", "Camille"],
    "es": ["Mateo", "Lucía", "Hugo", "Sofía", "Pablo", "María", "Diego", "Carmen"],
    "it": ["Leonardo", "Sofia", "Marco", "Giulia", "Matteo", "Aurora", "Luca", "Alice"],
    "en": ["James", "Olivia", "William", "Emma", "Henry", "Ava", "Jack", "Mia"],
}
_TUSSENVOEGSELS = ["van", "van der", "van den", "de", "den", "ter", "ten", ""]
_SURNAMES = {
    "nl": [
        "van Dalen",
        "de Wit",
        "Jansen",
        "Meijer",
        "Bakker",
        "Visser",
        "Van Beek",
        "de Vries",
        "Bos",
        "Peters",
        "Hendriks",
        "Willemsen",
    ],
    "de": ["Müller", "Schmidt", "Weber", "Fischer", "Wagner", "Becker"],
    "fr": ["Dupont", "Martin", "Bernard", "Dubois", "Moreau", "Laurent"],
    "es": ["García", "Rodríguez", "Fernández", "López", "Martínez", "Sánchez"],
    "it": ["Rossi", "Russo", "Ferrari", "Esposito", "Bianchi", "Romano"],
    "en": ["Smith", "Johnson", "Brown", "Taylor", "Wilson", "Davies"],
}

_ORGS = {
    "nl": [
        "Beekman Advocaten",
        "De Groot Notariaat",
        "Zorggroep Rijnland",
        "Bouwbedrijf Terlouw",
        "Stichting Leefwereld",
        "Van Dijk Makelaardij",
        "Coöperatie De Eendracht",
        "Techniek Nederland BV",
    ],
    "de": ["Bergmann GmbH", "Klinikum Rheinland", "Schneider & Partner"],
    "fr": ["Cabinet Moreau", "Groupe Lefèvre", "Clinique Saint-Louis"],
    "es": ["Bufete Álvarez", "Clínica San Rafael", "Construcciones Ibéricas"],
    "it": ["Studio Legale Conti", "Ospedale San Giovanni", "Impresa Marchetti"],
    "en": ["Ashworth Legal", "Riverside Clinic", "Kingsley Holdings Ltd"],
}

_STREETS = {
    "nl": [
        "Kerkstraat",
        "Molenweg",
        "Dorpsstraat",
        "Julianalaan",
        "Beukenlaan",
        "Prins Hendrikkade",
        "Zonnebloemstraat",
        "Van Goghlaan",
    ],
    "de": ["Hauptstraße", "Gartenweg", "Lindenallee", "Bahnhofstraße"],
    "fr": ["Rue de la Paix", "Avenue des Tilleuls", "Boulevard Voltaire"],
    "es": ["Calle Mayor", "Avenida de la Constitución", "Paseo del Prado"],
    "it": ["Via Roma", "Corso Garibaldi", "Viale dei Pini"],
    "en": ["High Street", "Oak Avenue", "Station Road", "Maple Close"],
}
_CITIES = {
    "nl": [
        ("Amsterdam", "1011 AB"),
        ("Utrecht", "3511 CD"),
        ("Leiden", "2311 EF"),
        ("Groningen", "9711 GH"),
        ("Eindhoven", "5611 JK"),
    ],
    "de": [("Köln", "50667"), ("München", "80331"), ("Hamburg", "20095")],
    "fr": [("Paris", "75001"), ("Lyon", "69001"), ("Nantes", "44000")],
    "es": [("Madrid", "28001"), ("Sevilla", "41001"), ("Valencia", "46001")],
    "it": [("Roma", "00184"), ("Milano", "20121"), ("Napoli", "80133")],
    "en": [("London", "EC1A 1BB"), ("Manchester", "M1 1AE"), ("Bristol", "BS1 4DJ")],
}

_MEDICAL_CONDITIONS = [
    "diabetes type 2",
    "astma",
    "hypertensie",
    "depressie",
    "migraine",
    "reumatoïde artritis",
    "COPD",
    "hartfalen",
    "epilepsie",
    "hypothyreoïdie",
    "burn-out",
    "chronische nierinsufficiëntie",
    "ADHD",
    "coeliakie",
]
_MEDICATIONS = [
    "metformine",
    "salbutamol",
    "paracetamol",
    "amlodipine",
    "sertraline",
    "ibuprofen",
    "levothyroxine",
    "omeprazol",
    "atorvastatine",
    "prednison",
    "insuline glargine",
    "methylfenidaat",
]

_ORG_SUFFIX = {"nl": "", "de": "", "fr": "", "es": "", "it": "", "en": ""}


def _lang(rng: random.Random, lang: str, table: dict) -> list:
    return table.get(lang) or table["nl"]


# ── Fuzzy generators ───────────────────────────────────────────────────────


def gen_person(rng: random.Random, lang: str = "nl") -> tuple[str, str]:
    first = rng.choice(_lang(rng, lang, _FIRST_NAMES))
    if lang == "nl" and rng.random() < 0.5:
        tv = rng.choice(_TUSSENVOEGSELS)
        base = rng.choice(_lang(rng, lang, _SURNAMES)).split()[-1]
        surname = f"{tv} {base}".strip() if tv else base
    else:
        surname = rng.choice(_lang(rng, lang, _SURNAMES))
    return f"{first} {surname}", "name_full"


def gen_organization(rng: random.Random, lang: str = "nl") -> tuple[str, str]:
    return rng.choice(_lang(rng, lang, _ORGS)), "org"


def gen_address(rng: random.Random, lang: str = "nl") -> tuple[str, str]:
    street = rng.choice(_lang(rng, lang, _STREETS))
    number = rng.randint(1, 240)
    city, postcode = rng.choice(_lang(rng, lang, _CITIES))
    if lang == "nl":
        return f"{street} {number}, {postcode} {city}", "address_full"
    return f"{street} {number}, {postcode} {city}", "address_full"


def gen_date_of_birth(rng: random.Random, lang: str = "nl") -> tuple[str, str]:
    day = rng.randint(1, 28)
    month = rng.randint(1, 12)
    year = rng.randint(1945, 2007)
    months_nl = [
        "januari",
        "februari",
        "maart",
        "april",
        "mei",
        "juni",
        "juli",
        "augustus",
        "september",
        "oktober",
        "november",
        "december",
    ]
    style = rng.random()
    if style < 0.4:
        return f"{day:02d}-{month:02d}-{year}", "dob_numeric"
    if style < 0.7:
        return f"{day} {months_nl[month - 1]} {year}", "dob_written"
    return f"{year}-{month:02d}-{day:02d}", "dob_iso"


def gen_passport(rng: random.Random, lang: str = "nl") -> tuple[str, str]:
    letters = "".join(rng.choice(string.ascii_uppercase) for _ in range(2))
    if lang == "en" or rng.random() < 0.12:
        # UK passports issued from 2015 are two letters then seven DIGITS.
        return f"{letters}{rng.randint(1000000, 9999999)}", "passport_gb"
    body = "".join(rng.choice(string.ascii_uppercase + string.digits) for _ in range(7))
    return f"{letters}{body}", "passport_nl"


def gen_drivers_license(rng: random.Random, lang: str = "nl") -> tuple[str, str]:
    if lang == "en" or rng.random() < 0.12:
        # DVLA: SSSSS NMMDD NIIXA A — surname (trailing-9 padded), decade digit,
        # month (+50 for female), day, year digit, initials, then check chars.
        surname = "".join(
            rng.choice(string.ascii_uppercase) for _ in range(rng.randint(2, 5))
        )
        surname = (surname + "99999")[:5]
        month = rng.randint(1, 12) + (50 if rng.random() < 0.5 else 0)
        initials = "".join(rng.choice(string.ascii_uppercase + "9") for _ in range(2))
        return (
            f"{surname}{rng.randint(0, 9)}{month:02d}{rng.randint(1, 28):02d}"
            f"{rng.randint(0, 9)}{initials}"
            f"{rng.choice(string.ascii_uppercase + string.digits)}"
            f"{rng.choice(string.ascii_uppercase)}"
            f"{rng.choice(string.ascii_uppercase)}"
        ), "dl_gb"
    # NL driving licence document number: 10 digits.
    return "".join(str(rng.randint(0, 9)) for _ in range(10)), "dl_nl"


def gen_bank_account(rng: random.Random, lang: str = "nl") -> tuple[str, str]:
    # A plain (non-IBAN) account number — old-style NL rekeningnummer. Always
    # 10 digits: a 9-digit value could accidentally satisfy the BSN elfproef
    # and be mis-detected as a NationalIdentificationNumber, polluting metrics.
    return "".join(str(rng.randint(0, 9)) for _ in range(10)), "acct_plain"


def gen_health_insurance(rng: random.Random, lang: str = "nl") -> tuple[str, str]:
    """Health insurance identifiers — Dutch polisnummer and the UK NHS number.

    The Dutch form has no checksum and no fixed layout, so it is unmatchable by
    construction; that is a true statement about the category and stays. The
    NHS number is the opposite — ten digits with a mod-11 check — and adding it
    is what makes the ported UK spec measurable at all. Kind suffix `_gb` so
    eval/metrics attributes it to the right region.
    """
    if lang == "de" or rng.random() < 0.12:
        return _gen_de_kvnr(rng), "health_ins_de"

    if rng.random() < 0.3:
        for _ in range(200):
            body = f"{rng.randint(100, 999)}{rng.randint(0, 999999):06d}"
            total = sum(int(d) * w for d, w in zip(body, range(10, 1, -1)))
            check = (11 - total % 11) % 11
            if check == 10:  # would need a two-digit check — never issued
                continue
            nhs = f"{body}{check}"
            if not _is_valid_uk_nhs(nhs):
                raise AssertionError(f"generated NHS number failed validator: {nhs}")
            if rng.random() < 0.6:  # written grouped 3-3-4 more often than not
                return f"{nhs[:3]} {nhs[3:6]} {nhs[6:]}", "health_ins_gb"
            return nhs, "health_ins_gb"
        raise AssertionError("could not generate a valid NHS number")

    # NL zorgverzekering polisnummer: alnum, ~8-10 chars. Force at least two
    # letters so it can never collapse to a 9-digit BSN candidate.
    n = rng.choice([8, 9, 10])
    chars = [rng.choice(string.ascii_uppercase) for _ in range(2)]
    chars += [rng.choice(string.ascii_uppercase + string.digits) for _ in range(n - 2)]
    rng.shuffle(chars)
    return "".join(chars), "health_ins_nl"


def gen_medical_condition(rng: random.Random, lang: str = "nl") -> tuple[str, str]:
    return rng.choice(_MEDICAL_CONDITIONS), "condition"


def gen_medication(rng: random.Random, lang: str = "nl") -> tuple[str, str]:
    return rng.choice(_MEDICATIONS), "medication"


# ── Deterministic generators (validated against the service) ───────────────


def gen_email(rng: random.Random, lang: str = "nl") -> tuple[str, str]:
    first = rng.choice(_lang(rng, lang, _FIRST_NAMES)).lower()
    surname = rng.choice(_lang(rng, lang, _SURNAMES)).split()[-1].lower()
    surname = surname.encode("ascii", "ignore").decode() or "test"
    domain = rng.choice(["example.nl", "example.com", "example.org"])
    return f"{first}.{surname}@{domain}", "email"


def gen_phone(rng: random.Random, lang: str = "nl") -> tuple[str, str]:  # noqa: PLR0911
    """Phone numbers across the formats people actually type.

    This generator used to emit only ``06-XXXXXXXX``, ``+31 6 …`` and
    ``+31 XX XXX XXX`` — every one of which carries a separator or a ``+``.
    That is precisely the subset the old regex tier required, so the corpus
    could not express the single most common real form (a bare ``0644137044``)
    and scored the regex tier 1.00 on a question it was never asked.

    The bare variants below are the honest hard case and the place a
    context-reading detector beats a pattern: ``factuurnummer 0123456789`` is
    the same shape and must NOT be a phone number.

    Every format carries a distinct ``value_kind`` so recall can be broken down
    per format rather than averaged into a single misleading number.
    """
    body = "".join(str(rng.randint(0, 9)) for _ in range(8))
    a, b, c, d = body[:2], body[2:4], body[4:6], body[6:]
    area = rng.choice(["010", "020", "030", "040", "070", "013", "038"])
    sub = "".join(str(rng.randint(0, 9)) for _ in range(7))

    # Non-NL locales get their own national formats ~half the time, so the
    # corpus stops implying every phone number on earth is Dutch.
    if lang != "nl" and rng.random() < 0.5:
        return rng.choice(
            [
                (f"+49 151 {body}", "phone_de_intl"),
                (f"+32 4{body[:2]} {b} {c} {d}", "phone_be_intl"),
                (f"+33 6 {a} {b} {c} {d}", "phone_fr_intl"),
                (f"+44 7700 9{body[:5]}", "phone_uk_intl"),
                (f"({body[:3]}) {body[3:6]}-{body[3:7]}", "phone_us"),
            ]
        )

    style = rng.random()
    if style < 0.22:
        return f"06{body}", "phone_nl_mobile_bare"  # 0644137044
    if style < 0.36:
        return f"06 {a} {b} {c} {d}", "phone_nl_mobile_spaced"  # 06 44 13 70 44
    if style < 0.50:
        return f"06-{body}", "phone_nl_mobile"  # 06-44137044
    if style < 0.60:
        return f"{area}{sub}", "phone_nl_landline_bare"  # 0201234567
    if style < 0.70:
        return f"{area}-{sub}", "phone_nl_landline"  # 020-1234567
    if style < 0.78:
        return f"+31 (0)6 {body}", "phone_nl_intl_paren"  # +31 (0)6 44137044
    if style < 0.86:
        return f"0031{body[:1]}{body}", "phone_nl_intl_00"  # 0031644137044
    if style < 0.94:
        return f"+31 6 {body}", "phone_nl_intl"
    return f"+31 {a} {body[2:5]} {body[5:]}", "phone_generic"


# BBAN shape per country: (bank-code length, alphabetic bank code?, account length).
# mod-97 is computed for whichever country we emit, so every value is a real,
# well-formed IBAN for that jurisdiction.
_IBAN_SHAPES: dict[str, tuple[int, bool, int]] = {
    "NL": (4, True, 10),
    "DE": (8, False, 10),
    "BE": (3, False, 9),
    "FR": (10, False, 13),
    "ES": (8, False, 12),
    "IT": (11, False, 12),
    "GB": (4, True, 14),
}


def gen_iban(rng: random.Random, lang: str = "nl") -> tuple[str, str]:
    """IBANs across the EU jurisdictions this product actually serves.

    Was NL-only regardless of ``lang``, which meant a German or French document
    in the corpus still contained exclusively Dutch bank accounts. Length and
    BBAN shape vary a lot by country (BE is 16 chars, FR and IT are 27), and
    that variation is exactly what a length-sensitive detector gets wrong.
    """
    country = "NL"
    if lang != "nl" and rng.random() < 0.6:
        by_lang = {"de": "DE", "fr": "FR", "es": "ES", "it": "IT", "en": "GB"}
        country = by_lang.get(lang, rng.choice(list(_IBAN_SHAPES)))

    bank_len, alpha_bank, acct_len = _IBAN_SHAPES[country]
    if alpha_bank:
        pool = (
            ["TEST", "BANK", "XMPL", "DEMO", "ABNA", "INGB", "RABO"]
            if bank_len == 4
            else None
        )
        bank = (
            rng.choice(pool)
            if pool
            else "".join(rng.choice(string.ascii_uppercase) for _ in range(bank_len))
        )
    else:
        bank = "".join(str(rng.randint(0, 9)) for _ in range(bank_len))
    account = "".join(str(rng.randint(0, 9)) for _ in range(acct_len))
    bban = f"{bank}{account}"
    check = _iban_check_digits(country, bban)
    iban = f"{country}{check}{bban}"
    if not _is_valid_iban(iban):  # defensive — must never happen
        raise AssertionError(f"generated IBAN failed validator: {iban}")

    # A TYPO'D account about 8% of the time: one digit off, so mod-97 fails.
    # Still gold-labeled IBAN — a mistyped real account is still PII, and this
    # is the population the near-miss demote-never-drop emission exists for.
    # Any single-digit change breaks mod-97 (97 is prime; the delta d'-d and
    # the positional power of 10 are both units mod 97), so no re-check loop
    # is needed — asserted anyway, against the day someone edits this.
    if rng.random() < 0.08:
        body = list(iban)
        digit_positions = [i for i, ch in enumerate(body) if ch.isdigit() and i >= 4]
        pos = rng.choice(digit_positions)
        body[pos] = str((int(body[pos]) + rng.randint(1, 9)) % 10)
        typo = "".join(body)
        if _is_valid_iban(typo):  # unreachable by the argument above
            raise AssertionError(f"typo'd IBAN still validates: {typo}")
        if rng.random() < 0.3:
            typo = " ".join(typo[i : i + 4] for i in range(0, len(typo), 4))
        return typo, "iban_typo"

    # Written with spaces in groups of four about a fifth of the time — how
    # people actually paste them, and a shape that splits the token stream.
    if rng.random() < 0.2:
        iban = " ".join(iban[i : i + 4] for i in range(0, len(iban), 4))
        return iban, f"iban_{country.lower()}_spaced"
    return iban, f"iban_{country.lower()}"


def _iban_check_digits(country: str, bban: str) -> str:
    rearranged = bban + country + "00"
    numeric = "".join(
        c if c.isdigit() else str(ord(c) - 55) for c in rearranged.upper()
    )
    check = 98 - (int(numeric) % 97)
    return f"{check:02d}"


# Standard, publicly-documented Luhn-valid test PANs (never real cards).
_TEST_PANS = [
    "4111111111111111",
    "4012888888881881",
    "5555555555554444",
    "5105105105105100",
    "378282246310005",
    "6011111111111117",
]


def gen_credit_card(rng: random.Random, lang: str = "nl") -> tuple[str, str]:
    pan = rng.choice(_TEST_PANS)
    if not _is_valid_luhn(pan):
        raise AssertionError(f"test PAN failed Luhn: {pan}")

    # A MISTYPED card about 8% of the time, in the GROUPED notation only:
    # the near-miss net deliberately covers 4-4-4-4 / 4-6-5 (card notation)
    # and not bare runs (as likely an order number). One digit off always
    # breaks Luhn — the per-digit transform is injective mod 10.
    if rng.random() < 0.08:
        body = list(pan)
        pos = rng.randrange(len(body))
        body[pos] = str((int(body[pos]) + rng.randint(1, 9)) % 10)
        typo = "".join(body)
        if _is_valid_luhn(typo):  # unreachable — see above
            raise AssertionError(f"typo'd PAN still passes Luhn: {typo}")
        if len(typo) == 16:
            typo = " ".join(typo[i : i + 4] for i in range(0, 16, 4))
        else:  # Amex 4-6-5
            typo = f"{typo[:4]} {typo[4:10]} {typo[10:]}"
        return typo, "cc_typo"

    # Sometimes format with spaces (still matched by the CC regex).
    if len(pan) == 16 and rng.random() < 0.5:
        pan = " ".join(pan[i : i + 4] for i in range(0, 16, 4))
    return pan, "credit_card_test"


def _gen_bsn_nl(rng: random.Random) -> str:
    """A Dutch BSN with a valid elfproef."""
    for _ in range(200):
        first8 = [rng.randint(0, 9) for _ in range(8)]
        weights = (9, 8, 7, 6, 5, 4, 3, 2)
        partial = sum(w * d for w, d in zip(weights, first8))
        d9 = partial % 11
        if d9 == 10:
            continue
        digits = "".join(str(d) for d in first8) + str(d9)
        if _is_valid_bsn(digits):
            return digits
    raise AssertionError("could not generate a valid BSN")


# ── Foreign national identifiers, CONSTRUCTED against their checksums ──────
#
# These used to be random digit runs. That was not a small inaccuracy — it made
# four shipped detectors unmeasurable. Every non-Dutch national-ID spec in
# app/services/pii_regex.py is checksum-gated, so a random eleven-digit
# "natid_de" could never be detected by anything, and the by_region report
# attributed the resulting miss to the detector rather than to the corpus. The
# measured DE (0.565) and FR (0.563) recall came entirely from licence plates
# and IBANs; the national-ID column was structurally zero and looked like a
# quality problem.
#
# Constructing against eval/validators.py keeps the corpus independent of the
# detector — the rule this whole harness rests on — while making the values
# genuinely well-formed. Each generator asserts its own output, so a wrong
# construction fails at generation time rather than showing up as a mysterious
# recall dip weeks later.


_FOREIGN_COUNTRIES = ("de", "fr", "es", "it", "gb", "be", "pl", "se", "at")


def _pick_country(rng: random.Random, lang: str, by_lang: dict[str, str]) -> str:
    """Which country's identifier appears in a document written in *lang*.

    The obvious mapping — German document, German identifier — was written as
    ``by_lang.get(lang, rng.choice(pool))``, and the fallback was DEAD CODE: the
    corpus only ever emits nl/de/fr/es/it/en, every one of which is a key, so
    the pool was never drawn from. BE, PL, SE and AT therefore had zero values
    in the corpus, and the four shipped detectors for them were measuring
    nothing at all. That is why `by_region` had no Belgian row to be surprised
    by — not because Belgium scored badly, but because the question was never
    asked.

    It is also wrong on the merits. Document language is not identifier
    nationality: a Dutch care provider writes Dutch prose about a Polish
    employee's PESEL, which is the same observation pii_regex.py makes about
    anchor LANGUAGE. So the language bias stays — most identifiers in a German
    document are German — but a minority of documents carry a neighbour's.
    """
    if lang in by_lang and rng.random() < 0.65:
        return by_lang[lang]
    return rng.choice(_FOREIGN_COUNTRIES)


def _gen_de_taxid(rng: random.Random) -> str:
    """German Steuer-IdNr — ISO/IEC 7064 MOD 11,10, first digit non-zero."""
    for _ in range(200):
        head = [rng.randint(1, 9)] + [rng.randint(0, 9) for _ in range(9)]
        product = 10
        for d in head:
            total = (d + product) % 10
            product = (2 * (total or 10)) % 11
        digits = "".join(str(d) for d in head) + str((11 - product) % 10)
        if is_valid_iso7064_mod11_10(digits):
            return digits
    raise AssertionError("could not generate a valid Steuer-IdNr")


def _gen_de_rvnr(rng: random.Random) -> str:
    """German Rentenversicherungsnummer with a valid VKVV § 4 check digit."""
    for _ in range(200):
        day = rng.choice([rng.randint(1, 31), rng.randint(51, 81)])
        body = (
            f"{rng.randint(10, 99):02d}{day:02d}{rng.randint(1, 12):02d}"
            f"{rng.randint(0, 99):02d}"
        )
        letter = rng.choice(string.ascii_uppercase)
        serial = f"{rng.randint(0, 99):02d}"
        effective = body + str(ord(letter) - ord("A") + 1).zfill(2) + serial
        total = 0
        for ch, w in zip(effective, (2, 1, 2, 5, 7, 1, 2, 1, 2, 1, 2, 1)):
            product = int(ch) * w
            total += product // 10 + product % 10
        value = f"{body}{letter}{serial}{total % 10}"
        if is_valid_de_rvnr(value):
            return value
    raise AssertionError("could not generate a valid RVNR")


def _gen_de_kvnr(rng: random.Random) -> str:
    """German Krankenversicherungsnummer with a valid GKV check digit."""
    for _ in range(200):
        letter = rng.choice(string.ascii_uppercase)
        body = f"{rng.randint(0, 99999999):08d}"
        effective = str(ord(letter) - ord("A") + 1).zfill(2) + body
        total = 0
        for ch, w in zip(effective, (1, 2) * 5):
            product = int(ch) * w
            total += product - 9 if product >= 10 else product
        value = f"{letter}{body}{total % 10}"
        if is_valid_de_kvnr(value):
            return value
    raise AssertionError("could not generate a valid KVNR")


def _gen_be_natid(rng: random.Random) -> str:
    """Belgian rijksregisternummer — mod-97 over the first nine digits."""
    for _ in range(200):
        body = (
            f"{rng.randint(50, 99):02d}{rng.randint(1, 12):02d}"
            f"{rng.randint(1, 28):02d}{rng.randint(1, 999):03d}"
        )
        digits = f"{body}{97 - int(body) % 97:02d}"
        if is_valid_be_national_id(digits):
            return digits
    raise AssertionError("could not generate a valid rijksregisternummer")


def _gen_fr_nir(rng: random.Random) -> str:
    """French NIR — 13-digit body plus a mod-97 key.

    The leading digit is the sex code and is 1 or 2; the shipped pattern
    requires it, so a run starting 3-9 would be invisible however valid its key.
    """
    for _ in range(200):
        body = (
            f"{rng.choice('12')}{rng.randint(30, 99):02d}"
            f"{rng.randint(1, 12):02d}{rng.randint(1, 95):02d}"
            f"{rng.randint(1, 999):03d}{rng.randint(1, 999):03d}"
        )
        value = f"{body}{97 - int(body) % 97:02d}"
        if is_valid_fr_nir(value):
            return value
    raise AssertionError("could not generate a valid NIR")


def _gen_es_dni(rng: random.Random) -> str:
    """Spanish DNI or NIE — the trailing letter is a mod-23 table lookup.

    Both forms keep the ``natid_es`` value_kind: eval/metrics._region_of reads
    the LAST underscore-separated token, so a "natid_es_nie" kind would be
    filed under region "any" and quietly vanish from the Spanish row.
    """
    table = "TRWAGMYFPDXBNJZSQVHLCKE"
    if rng.random() < 0.25:
        prefix = rng.choice("XYZ")
        digits = f"{rng.randint(1000000, 9999999):07d}"
        # X/Y/Z stand in for 0/1/2 before the modulo.
        head = f"{'XYZ'.index(prefix)}{digits}"
        value = f"{prefix}{digits}{table[int(head) % 23]}"
    else:
        digits = f"{rng.randint(10000000, 99999999)}"
        value = f"{digits}{table[int(digits) % 23]}"
    if not is_valid_es_dni(value):
        raise AssertionError(f"generated DNI/NIE failed validator: {value}")
    return value


def _gen_pl_pesel(rng: random.Random) -> str:
    """Polish PESEL — weighted mod-10 over the ten leading digits."""
    for _ in range(200):
        body = (
            f"{rng.randint(40, 99):02d}{rng.randint(1, 12):02d}"
            f"{rng.randint(1, 28):02d}{rng.randint(0, 9999):04d}"
        )
        weights = (1, 3, 7, 9, 1, 3, 7, 9, 1, 3)
        total = sum(w * int(d) for w, d in zip(weights, body))
        digits = body + str((10 - total % 10) % 10)
        if is_valid_pl_pesel(digits):
            return digits
    raise AssertionError("could not generate a valid PESEL")


def _gen_se_personnummer(rng: random.Random) -> str:
    """Swedish personnummer — Luhn over ten digits, written YYMMDD-NNNC.

    The separator is not decoration: the shipped pattern requires it, because a
    bare ten-digit run is indistinguishable from far too much else.
    """
    for _ in range(200):
        body = (
            f"{rng.randint(40, 99):02d}{rng.randint(1, 12):02d}"
            f"{rng.randint(1, 28):02d}{rng.randint(100, 999):03d}"
        )
        total = 0
        for i, ch in enumerate(body):
            d = int(ch) * (2 if i % 2 == 0 else 1)
            total += d - 9 if d > 9 else d
        digits = body + str((10 - total % 10) % 10)
        if is_valid_se_personnummer(digits):
            return f"{digits[:6]}-{digits[6:]}"
    raise AssertionError("could not generate a valid personnummer")


def _gen_at_svnr(rng: random.Random) -> str:
    """Austrian SVNR — weighted mod-11 with the check digit at position 4.

    Position 4 carries weight 0, so the check digit does not contribute to its
    own sum and can be solved for directly rather than searched.
    """
    for _ in range(200):
        serial = f"{rng.randint(100, 999)}"
        date = (
            f"{rng.randint(1, 28):02d}{rng.randint(1, 12):02d}{rng.randint(40, 99):02d}"
        )
        weights = (3, 7, 9, 0, 5, 8, 4, 2, 1, 6)
        total = sum(w * int(d) for w, d in zip(weights, f"{serial}0{date}")) % 11
        if total == 10:
            continue
        digits = f"{serial}{total}{date}"
        if is_valid_at_svnr(digits):
            return digits
    raise AssertionError("could not generate a valid SVNR")


def gen_bsn(rng: random.Random, lang: str = "nl") -> tuple[str, str]:  # noqa: C901, PLR0911, PLR0912
    """National identification numbers — Dutch BSN plus EU equivalents.

    The category is `NationalIdentificationNumber`, not "BSN", but the corpus
    only ever emitted Dutch BSNs and the detector only ever knew the elfproef.
    That hid something important about the GLiNER-only cutover:

      **the checksum exception is NL-only.** A Belgian rijksregisternummer, a
      German Steuer-ID or a Spanish DNI is the same category of personal data,
      is equally a leak, and the elfproef says nothing about any of them. For
      every one of these, GLiNER is already the only detector we have.

    So these values are not "extra coverage" — they are the part of the
    category that the regex tier never protected in the first place.

    Dutch documents carry a minority of foreign identifiers too. Gating the
    whole branch on ``lang != "nl"`` said that a Dutch document never mentions a
    foreign ID, which is both false — a Dutch care provider writes Dutch prose
    about a Polish employee's PESEL, and that is the product's most common
    non-Dutch case — and the reason the smaller countries had single-digit span
    counts: three quarters of the corpus is Dutch and was excluded by
    construction.
    """
    if rng.random() < (0.15 if lang == "nl" else 0.6):
        choice = _pick_country(
            rng, lang, {"de": "de", "fr": "fr", "es": "es", "it": "it", "en": "gb"}
        )
        if choice == "de":
            # Germany has two personal identifiers in circulation: the lifelong
            # Steuer-IdNr and the Rentenversicherungsnummer. Both are
            # NationalIdentificationNumber, they look nothing alike, and the
            # corpus only ever contained the first — so the RVNR spec (which was
            # also written with the wrong letter positions) had never been
            # exercised by anything.
            # Its own value_kind, still ending in `_de` so eval/metrics._region_of
            # keeps attributing it to Germany. One kind cannot carry two
            # algorithms: the harness checks each generated value against the
            # checksum its kind names, and an RVNR is not a Steuer-IdNr.
            if rng.random() < 0.3:
                return _gen_de_rvnr(rng), "natid_rvnr_de"
            digits = _gen_de_taxid(rng)
            # Written both ways in practice, and the two forms exercise
            # DIFFERENT specs: the grouped form is unanchored and complete, the
            # bare run needs a keyword within 40 chars. Emitting only one would
            # leave half the German detector untested.
            if rng.random() < 0.5:
                return (
                    f"{digits[:2]} {digits[2:5]} {digits[5:8]} {digits[8:]}"
                ), "natid_de"
            return digits, "natid_de"
        if choice == "be":  # rijksregisternummer YY.MM.DD-NNN.CC
            d = _gen_be_natid(rng)
            return f"{d[0:2]}.{d[2:4]}.{d[4:6]}-{d[6:9]}.{d[9:]}", "natid_be"
        if choice == "fr":  # NIR, 13 digits + 2-digit key
            return _gen_fr_nir(rng), "natid_fr"
        if choice == "es":  # DNI, 8 digits + letter (or NIE)
            return _gen_es_dni(rng), "natid_es"
        if choice == "pl":  # PESEL, 11 digits
            return _gen_pl_pesel(rng), "natid_pl"
        if choice == "se":  # personnummer, YYMMDD-NNNC
            return _gen_se_personnummer(rng), "natid_se"
        if choice == "at":  # SVNR, NNNC DDMMYY
            d = _gen_at_svnr(rng)
            if rng.random() < 0.5:
                return f"{d[:4]} {d[4:]}", "natid_at"
            return d, "natid_at"
        if choice == "it":  # codice fiscale
            L = lambda n: "".join(rng.choice(string.ascii_uppercase) for _ in range(n))
            return (
                f"{L(3)}{L(3)}{rng.randint(50, 99):02d}"
                f"{rng.choice('ABCDEHLMPRST')}{rng.randint(10, 28):02d}"
                f"{L(1)}{rng.randint(100, 999)}{L(1)}"
            ), "natid_it"
        # gb — NINO. The two prefix letters follow POSITION-SPECIFIC alphabets
        # (no D/F/I/Q/U/V in either, and no O in the second), and seven pairs
        # are never issued. The old generator drew both letters from one loose
        # alphabet, so it emitted NINOs that HMRC would never issue — values a
        # faithful pattern is right to reject, which would have read as a
        # detector miss.
        for _ in range(50):
            pair = rng.choice("ABCEGHJKLMNOPRSTWXYZ") + rng.choice(
                "ABCEGHJKLMNPRSTWXYZ"
            )
            if pair not in ("BG", "GB", "NK", "KN", "NT", "TN", "ZZ"):
                break
        return (f"{pair}{rng.randint(100000, 999999)}{rng.choice('ABCD')}"), "natid_gb"

    return _gen_bsn_nl(rng), "bsn_valid"


def gen_ssn(rng: random.Random, lang: str = "nl") -> tuple[str, str]:
    # A never-issued-range SSN about 8% of the time — the dashed 3-2-4 layout
    # with area 000/666/9xx. Still gold-labeled: a mistyped SSN is still PII,
    # and the distinctive layout is what earns the near-miss emission.
    if rng.random() < 0.08:
        area = rng.choice([0, 666, rng.randint(900, 999)])
        ssn = f"{area:03d}-{rng.randint(1, 99):02d}-{rng.randint(1, 9999):04d}"
        if _is_valid_ssn(ssn):
            raise AssertionError(f"bad-range SSN still validates: {ssn}")
        return ssn, "ssn_bad_range"

    for _ in range(100):
        area = rng.randint(1, 899)
        if area in (0, 666) or area >= 900:
            continue
        group = rng.randint(1, 99)
        serial = rng.randint(1, 9999)
        ssn = f"{area:03d}-{group:02d}-{serial:04d}"
        if _is_valid_ssn(ssn):
            return ssn, "ssn_us"
    raise AssertionError("could not generate a valid SSN")


def gen_ipv4(rng: random.Random, lang: str = "nl") -> tuple[str, str]:
    # TEST-NET documentation ranges (RFC 5737) — never routable.
    block = rng.choice(["192.0.2", "198.51.100", "203.0.113"])
    ip = f"{block}.{rng.randint(1, 254)}"
    if not _is_valid_ipv4(ip):
        raise AssertionError(f"generated IP failed validator: {ip}")
    return ip, "ipv4_doc"


def gen_url(rng: random.Random, lang: str = "nl") -> tuple[str, str]:
    host = rng.choice(["example.nl", "example.com", "docs.example.org"])
    path = rng.choice(["", "/dossier/42", "/zaak?id=7", "/artikel/privacy", "/p/123"])
    return f"https://{host}{path}", "url"


def gen_license_plate(rng: random.Random, lang: str = "nl") -> tuple[str, str]:  # noqa: C901, PLR0911
    def L():  # noqa: E743 - short local
        return rng.choice(string.ascii_uppercase)

    def D():
        return str(rng.randint(0, 9))

    # Non-NL plates use entirely different separator conventions (a space in DE
    # and UK, none of the RDW sidecodes). The regex tier hard-codes the six
    # Dutch sidecodes, so every one of these is invisible to it today — again,
    # coverage GLiNER would be adding rather than replacing.
    # Dutch documents get a minority share for the same reason gen_bsn does:
    # foreign plates turn up in Dutch prose constantly (cross-border traffic,
    # fleet leasing), and excluding them left PL/SE/AT unmeasured.
    if rng.random() < (0.15 if lang == "nl" else 0.6):
        which = _pick_country(
            rng, lang, {"de": "de", "fr": "fr", "es": "es", "it": "it", "en": "gb"}
        )
        if which == "de":
            return (f"{L()}{L()}-{L()}{L()} {rng.randint(1, 9999)}", "plate_de")
        if which == "be":
            # Current series: one leading digit, three letters, three digits.
            return f"{rng.choice('12')}-{L()}{L()}{L()}-{D()}{D()}{D()}", "plate_be"
        if which == "fr":
            return f"{L()}{L()}-{D()}{D()}{D()}-{L()}{L()}", "plate_fr"
        if which == "es":
            # Post-2000: four digits then three consonants.
            C = lambda: rng.choice("BCDFGHJKLMNPRSTVWXYZ")  # noqa: E731
            return f"{D()}{D()}{D()}{D()} {C()}{C()}{C()}", "plate_es"
        if which == "it":
            return f"{L()}{L()}{D()}{D()}{D()}{L()}{L()}", "plate_it"
        if which == "pl":
            return f"{L()}{L()} {D()}{L()}{D()}{D()}{D()}", "plate_pl"
        if which == "se":
            return f"{L()}{L()}{L()} {D()}{D()}{L()}", "plate_se"
        if which == "at":
            return f"{L()}-{rng.randint(1, 99999)} {L()}{L()}", "plate_at"
        # gb — current (2001+) series. The age identifier is only ever 02-29
        # (March) or 51-79 (September), and I/Q are not used as area letters;
        # the old generator emitted any two digits, so most of its plates were
        # registrations that cannot exist.
        A = lambda: rng.choice("ABCDEFGHJKLMNOPRSTUVWXY")  # noqa: E731
        S = lambda: rng.choice("ABCDEFGHJKLMNOPRSTUVWXYZ")  # noqa: E731
        age = rng.choice(list(range(2, 30)) + list(range(51, 80)))
        return f"{A()}{A()}{age:02d} {S()}{S()}{S()}", "plate_gb"

    formats = [
        lambda: f"{D()}{D()}-{L()}{L()}-{D()}{D()}",
        lambda: f"{L()}{L()}-{D()}{D()}-{L()}{L()}",
        lambda: f"{D()}{D()}-{L()}{L()}{L()}-{D()}",
        lambda: f"{L()}-{D()}{D()}{D()}-{L()}{L()}",
    ]
    return rng.choice(formats)(), "plate_nl"


def gen_tax_id(rng: random.Random, lang: str = "nl") -> tuple[str, str]:
    """Tax identifiers — Dutch BTW plus the German Steuernummer.

    Was BTW-only regardless of language, which is why the German tax specs
    landed unmeasured: `by_region` could show DE tax coverage only if a German
    tax number existed in the corpus, and none did.
    """
    if lang == "de" or rng.random() < 0.1:
        if rng.random() < 0.5:
            # Steuernummer, ELSTER 13-digit form: Bundesland code 01-16 then 11.
            return (
                f"{rng.randint(1, 16):02d}"
                + "".join(str(rng.randint(0, 9)) for _ in range(11))
            ), "vat_de"
        # State-specific slashed form (Bayern/BW 3/3/5).
        return (
            f"{rng.randint(100, 999)}/{rng.randint(100, 999)}/"
            f"{rng.randint(10000, 99999)}"
        ), "vat_de"

    # Dutch BTW (VAT): NL + 9 digits + B + 2 digits. Regex is precise; no
    # validator, so any well-formed value is detected.
    digits = "".join(str(rng.randint(0, 9)) for _ in range(9))
    suffix = f"{rng.randint(1, 99):02d}"
    return f"NL{digits}B{suffix}", "btw_nl"


# ── TaxIdentificationNumber, the other two branches ────────────────────────
# The category has THREE shapes in production but the corpus only ever emitted
# BTW, so its reported recall of 1.000 said nothing about the other two. Both
# of these are context-anchored in the regex tier — bare, they are simply an
# 8- or 9-digit run — which makes them a sharp test of whether a context-reading
# detector can replace an anchor-plus-checksum rule.
#
# Not registered in GENERATORS: TaxIdentificationNumber already maps to
# gen_tax_id. generate_corpus.py calls these directly to build anchored
# templates, so the value and its anchor phrase always agree.


def gen_kvk(rng: random.Random) -> tuple[str, str]:
    """KVK (Chamber of Commerce): 8 digits, no checksum — anchor is everything."""
    return "".join(str(rng.randint(0, 9)) for _ in range(8)), "kvk_nl"


def gen_rsin(rng: random.Random) -> tuple[str, str]:
    """RSIN: 9 digits sharing the BSN elfproef, disambiguated only by context."""
    while True:
        digits = "".join(str(rng.randint(0, 9)) for _ in range(9))
        if _is_valid_bsn(digits):
            return digits, "rsin_nl"


def gen_api_key(rng: random.Random, lang: str = "nl") -> tuple[str, str]:
    # Synthetic, non-functional secret. Uses the vendor-prefixed patterns the
    # guard's regex recognises. NOTE: these are fake test fixtures — the corpus
    # dir must be allowlisted for the repo secret-scan (see eval/README.md).
    kind = rng.random()
    if kind < 0.5:
        body = "".join(
            rng.choice(string.ascii_letters + string.digits) for _ in range(24)
        )
        return f"sk-{body}", "secret_openai_like"
    body = "".join(
        rng.choice(string.ascii_uppercase + string.digits) for _ in range(16)
    )
    return f"AKIA{body}", "secret_aws_like"


# ── Registry: category -> generator ────────────────────────────────────────
GENERATORS = {
    "Person": gen_person,
    "Organization": gen_organization,
    "Address": gen_address,
    "DateOfBirth": gen_date_of_birth,
    "PassportNumber": gen_passport,
    "DriversLicenseNumber": gen_drivers_license,
    "BankAccountNumber": gen_bank_account,
    "HealthInsuranceNumber": gen_health_insurance,
    "MedicalCondition": gen_medical_condition,
    "Medication": gen_medication,
    "Email": gen_email,
    "PhoneNumber": gen_phone,
    "InternationalBankingAccountNumber": gen_iban,
    "CreditCardNumber": gen_credit_card,
    "NationalIdentificationNumber": gen_bsn,
    "USSocialSecurityNumber": gen_ssn,
    "IPAddress": gen_ipv4,
    "URL": gen_url,
    "LicensePlateNumber": gen_license_plate,
    "TaxIdentificationNumber": gen_tax_id,
    "ApiKeyOrSecret": gen_api_key,
}

# Categories the regex tier owns (used for tier attribution in metrics and to
# know which generated values MUST pass a validator).
DETERMINISTIC_CATEGORIES = frozenset(
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
    }
)


def generate(category: str, rng: random.Random, lang: str = "nl") -> tuple[str, str]:
    """Generate one synthetic value for *category*. Raises on unknown category."""
    gen = GENERATORS.get(category)
    if gen is None:
        raise KeyError(f"no generator for category {category!r}")
    return gen(rng, lang)


__all__ = ["GENERATORS", "DETERMINISTIC_CATEGORIES", "generate"]

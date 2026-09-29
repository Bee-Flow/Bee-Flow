"""Deterministic synthetic corpus generator.

Compiles templates into gold-labelled records. Offsets are ALWAYS computed at
splice time — never hand-typed — via two authoring forms:

  * ``{{Category}}``          slot filled from value_banks.generate(...)
  * ``⟦Category|literal⟧``    inline annotation of a hand-written literal

Emits three files under ``eval/corpus/``:
  * short.jsonl      1-3 sentence chat messages, informal, 1-2 categories
  * large.jsonl      2k-20k char documents, 8-15 co-occurring categories, with
                     entities scattered into the deep tail (truncation stress)
  * negatives.jsonl  hard negatives (distractors that look like PII but aren't)

Run:  python -m eval.generate_corpus --seed 42
"""

from __future__ import annotations

import argparse
import json
import os
import random
import re
import sys

from .schema import Record, Span, normalize, validate_record, dump_jsonl
from . import value_banks as vb

_SLOT_RE = re.compile(r"\{\{(\w+)\}\}|⟦(\w+)\|([^⟧]*)⟧")


def compile_template(
    template: str, rng: random.Random, lang: str
) -> tuple[str, list[Span]]:
    """Turn a template into (text, spans) with programmatically-computed offsets."""
    out: list[str] = []
    spans: list[Span] = []
    cursor = 0
    pos = 0
    for m in _SLOT_RE.finditer(template):
        literal = normalize(template[pos : m.start()])
        out.append(literal)
        cursor += len(literal)

        if m.group(1) is not None:  # {{Category}}
            category = m.group(1)
            value, kind = vb.generate(category, rng, lang)
        else:  # ⟦Category|literal⟧
            category = m.group(2)
            value, kind = m.group(3), "inline"
        value = normalize(value)

        spans.append(Span(cursor, cursor + len(value), category, value, kind))
        out.append(value)
        cursor += len(value)
        pos = m.end()

    tail = normalize(template[pos:])
    out.append(tail)
    return "".join(out), spans


# ── Short chat-message templates ───────────────────────────────────────────
# Informal Dutch dominates (lowercase names, missing tussenvoegsels); a few
# multilingual. Slots co-occur 1-3 categories.
_SHORT_TEMPLATES: list[tuple[str, str]] = [
    ("Hoi, kun je {{Person}} bellen op {{PhoneNumber}}? Bedankt!", "nl"),
    ("mijn mail is {{Email}}, stuur de factuur maar door", "nl"),
    ("Beste {{Person}}, uw afspraak staat gepland. Groet.", "nl"),
    (
        "Kun je overmaken naar {{InternationalBankingAccountNumber}} tnv {{Person}}?",
        "nl",
    ),
    ("het BSN van de client is {{NationalIdentificationNumber}}, klopt dat?", "nl"),
    ("ik woon op {{Address}}, kom je langs?", "nl"),
    ("betaling met kaart {{CreditCardNumber}} is mislukt", "nl"),
    ("server draait op {{IPAddress}}, check even de logs", "nl"),
    ("zie {{URL}} voor het volledige dossier", "nl"),
    ("mijn kenteken is {{LicensePlateNumber}}, staat de auto goed?", "nl"),
    ("{{Person}} heeft {{MedicalCondition}} en gebruikt {{Medication}}", "nl"),
    ("de organisatie {{Organization}} heeft getekend op {{DateOfBirth}}", "nl"),
    ("paspoortnummer {{PassportNumber}} en rijbewijs {{DriversLicenseNumber}}", "nl"),
    ("polisnummer {{HealthInsuranceNumber}} bij de zorgverzekeraar", "nl"),
    ("btw-nummer van het bedrijf is {{TaxIdentificationNumber}}", "nl"),
    ("api key: {{ApiKeyOrSecret}} — niet delen aub", "nl"),
    ("hey {{Person}}, wat is je nummer? de mijne is {{PhoneNumber}}", "nl"),
    ("rekeningnummer {{BankAccountNumber}} voor de terugbetaling", "nl"),
    ("Bitte {{Person}} unter {{PhoneNumber}} anrufen.", "de"),
    ("Contactez {{Person}} à {{Email}} s'il vous plaît.", "fr"),
    ("Por favor escribe a {{Person}} en {{Email}}.", "es"),
    ("Chiama {{Person}} al {{PhoneNumber}} grazie.", "it"),
    ("Please email {{Person}} at {{Email}} about the invoice.", "en"),
    ("geboortedatum {{DateOfBirth}} van {{Person}}", "nl"),
    ("stuur naar {{Email}} en cc {{Person}}", "nl"),
    (
        "het Amerikaanse SSN is {{USSocialSecurityNumber}}, nodig voor de belastingaangifte",
        "nl",
    ),
    ("The client's SSN {{USSocialSecurityNumber}} belongs to {{Person}}.", "en"),
]


def _informal(text: str) -> str:
    """Occasional informality: lowercase the sentence start (chat style)."""
    return text


# ── Large document builders ────────────────────────────────────────────────
_FILLER = [
    "In deze zaak zijn de betrokken partijen na uitvoerig overleg tot overeenstemming gekomen over de gemaakte afspraken.",
    "De onderstaande gegevens dienen uitsluitend ter administratieve verwerking en worden vertrouwelijk behandeld.",
    "Conform de geldende voorwaarden wordt verzocht de vermelde termijnen strikt in acht te nemen.",
    "Bij eventuele onduidelijkheden kan te allen tijde contact worden opgenomen met de behandelend medewerker.",
    "Het dossier bevat alle relevante stukken die noodzakelijk zijn voor de verdere behandeling van het verzoek.",
    "Partijen verklaren kennis te hebben genomen van de inhoud en gaan akkoord met de gestelde bepalingen.",
    "De verwerking van de aangeleverde documenten vindt plaats binnen de daarvoor gestelde wettelijke kaders.",
    "Voor de volledigheid wordt opgemerkt dat aan dit overzicht geen rechten kunnen worden ontleend.",
    "Na ontvangst van de benodigde bescheiden zal de aanvraag zo spoedig mogelijk in behandeling worden genomen.",
    "De gemaakte kosten worden conform de bijgevoegde specificatie in rekening gebracht.",
]

# Section skeletons: prose interleaved with slots. Each yields several slots.
_LARGE_SECTIONS: list[str] = [
    "Betreft: dossier van {{Person}}, geboren op {{DateOfBirth}}, woonachtig te {{Address}}. "
    "Contactgegevens: telefoon {{PhoneNumber}}, e-mail {{Email}}. ",
    "De wederpartij, {{Person}}, is bereikbaar via {{PhoneNumber}}. "
    "De betaling dient te geschieden op rekening {{InternationalBankingAccountNumber}} "
    "ten name van {{Organization}}. ",
    "Medische gegevens: cliënt is bekend met {{MedicalCondition}} en gebruikt dagelijks {{Medication}}. "
    "Het polisnummer bij de zorgverzekeraar is {{HealthInsuranceNumber}}. ",
    "Identificatie geschiedde aan de hand van paspoortnummer {{PassportNumber}} en "
    "rijbewijsnummer {{DriversLicenseNumber}}. Het burgerservicenummer is {{NationalIdentificationNumber}}. ",
    "Voor de zakelijke afhandeling geldt btw-nummer {{TaxIdentificationNumber}}. "
    "Overige correspondentie verloopt via {{Email}} en de website {{URL}}. ",
    "Aanvullend: kenteken {{LicensePlateNumber}}, oud rekeningnummer {{BankAccountNumber}}. "
    "De toegangssleutel voor het portaal luidt {{ApiKeyOrSecret}}. ",
    "De contactpersoon namens de instelling is {{Person}}, te bereiken op {{PhoneNumber}} of {{Email}}. "
    "Betalingen lopen via {{InternationalBankingAccountNumber}}. ",
    # Added so CreditCardNumber / IPAddress / USSocialSecurityNumber clear the
    # per-category quota. At 5, 5 and 10 gold spans they were far too small for
    # a per-category verdict to mean anything — a Wilson interval on n=5 spans
    # most of the unit interval, so "SAFE" and "REGRESSION" were the same cell.
    "Betaalgegevens: de transactie is verwerkt met kaartnummer {{CreditCardNumber}}. "
    "De aanvraag werd ingediend vanaf IP-adres {{IPAddress}} via het klantportaal. ",
    "Voor de Amerikaanse tegenpartij is het social security number {{USSocialSecurityNumber}} "
    "vastgelegd. Technisch contact verloopt via {{IPAddress}} en {{Email}}. ",
]


def build_large_doc(rng: random.Random, lang: str, doc_type: str) -> str:
    """Assemble one long template string: sections + filler, PII scattered deep."""
    parts: list[str] = [f"{doc_type}\n\n"]
    sections = _LARGE_SECTIONS[:]
    rng.shuffle(sections)
    # Interleave each section with a paragraph of filler so entities land at a
    # range of depths, including well past the first chunk (truncation stress).
    for i, sec in enumerate(sections):
        parts.append(sec)
        n_filler = rng.randint(2, 4)
        for _ in range(n_filler):
            parts.append(rng.choice(_FILLER) + " ")
        parts.append("\n\n")
    # A deep-tail section guarantees entities far past any single-chunk budget.
    parts.append(
        "Ter afsluiting van dit dossier volgen hieronder de definitieve gegevens. "
    )
    for _ in range(rng.randint(4, 7)):
        parts.append(rng.choice(_FILLER) + " ")
    parts.append(
        "De eindverantwoordelijke is {{Person}}, bereikbaar op {{PhoneNumber}} "
        "en per e-mail via {{Email}}. "
    )
    parts.append(rng.choice(_BSN_TAIL_VARIANTS))
    return "".join(parts)


# Deep-tail BSN phrasings, deliberately varied in how strongly they anchor.
#
# This list previously held a single line — "Het definitieve dossiernummer
# verwijst naar {{NationalIdentificationNumber}}" — which labelled a BSN as a
# *dossiernummer* (a case-file number). That is not a weak anchor, it is a
# WRONG one: a detector that tags it as a burgerservicenummer is believing the
# number over the sentence. It made GLiNER-only BSN recall look like 0.529 when
# the model was in fact finding 100% of the correctly-anchored spans and
# correctly declining the mislabelled ones.
#
# The mix below is deliberate. A detector that only fires on the word
# "burgerservicenummer" is a keyword matcher, not a detector, so a third of
# these carry no category keyword at all — that is the honest hard case, and
# the one where a checksum genuinely earns its place.
_BSN_TAIL_VARIANTS: list[str] = [
    "Het burgerservicenummer van betrokkene is {{NationalIdentificationNumber}}. ",
    "Het BSN in dit dossier luidt {{NationalIdentificationNumber}}. ",
    "Ter identificatie van de cliënt is {{NationalIdentificationNumber}} vastgelegd. ",
    "Tot slot is {{NationalIdentificationNumber}} toegevoegd aan het dossier. ",
]


_DOC_TYPES = [
    "VASTSTELLINGSOVEREENKOMST ECHTSCHEIDINGSMEDIATION",
    "MEDISCH INTAKEFORMULIER",
    "HR ONBOARDING DOSSIER",
    "VERZEKERINGSCLAIM — SCHADEMELDING",
    "FINANCIEEL OVERZICHT CLIËNT",
]


# ── Hard negatives ─────────────────────────────────────────────────────────
# Text full of things that LOOK like PII but aren't. Gold spans are empty; any
# detection here is a false positive (precision measurement).
_NEGATIVE_TEMPLATES: list[str] = [
    "Ordernummer 483920117 is verzonden, trackingcode staat in het systeem.",
    "Het artikel SKU AB1234567 is niet meer op voorraad, probeer een alternatief.",
    "De vergadering is verplaatst; de bank en de school waren beide gesloten.",
    "De ouders en de kinderen hebben de woning bezocht samen met de makelaar.",
    "Factuur 2024-00815 met totaalbedrag van 1299 euro is voldaan.",
    "Serienummer 8829301 en modelcode XY-99 staan op de verpakking.",
    "De notaris en de mediator bespraken de gang van zaken met de partijen.",
    "Referentie 100200300 hoort bij het interne ticket, geen persoonsgegevens.",
    "De temperatuur was 21 graden en de meting 192 werd genoteerd om 14 uur.",
    "Kamer 305 op de tweede verdieping, toestelnummer 4021 intern.",
    "Het product kost 49,99 en heeft batchnummer 77123456 op het label.",
    "De heer sprak over het gezin, de werkgever en de betrokken partij.",
    # ── Distractors aimed at the categories losing a checksum ──────────
    # Each of these is the exact shape of a category the regex tier used to
    # reject by validator or anchor. With that gone, only context separates
    # them from real PII — so these ARE the precision measurement.
    # 10 digits starting with 0: identical in shape to a bare NL mobile.
    # A `\b0\d{9}\b` phone regex false-positives every one of these; the
    # measured reason a pattern patch was rejected in favour of the model.
    "Factuurnummer 0123456789 is verzonden naar de crediteurenadministratie.",
    "Het dossiernummer 0847213906 hoort bij de lopende aanvraag.",
    "Ordernummer 0611420385 staat nog open in het bestelsysteem.",
    "Referentiecode 0209948171 is intern toegekend aan dit verzoek.",
    # 9-digit runs that are NOT valid BSNs (elfproef fails) — the old tier
    # rejected these arithmetically; nothing does now.
    "Het interne kenmerk 123456789 verwijst naar de archiefdoos.",
    "Artikelcode 987654321 is vervallen per het nieuwe assortiment.",
    "Zaaknummer 111222333 is gesloten na afronding van de procedure.",
    "De meterstand 300100200 is doorgegeven aan de netbeheerder.",
    # 8-digit runs with no KVK anchor — KVK detection was anchor-only.
    "Batchcode 45012399 staat vermeld op de achterzijde van de doos.",
    "Het bestelnummer 90887766 kon niet worden teruggevonden.",
    # IBAN-shaped but mod-97 invalid.
    "Interne referentie NL00BANK0123456789 wordt niet meer gebruikt.",
    "De code NL12ABCD3456789012 hoort bij het oude archiefsysteem.",
    # 13-19 digit runs that fail Luhn — credit-card shaped.
    "De EAN-code 4006381333931 staat op de verpakking vermeld.",
    "IMEI 490154203237518 is geregistreerd bij de leverancier.",
    "Contractnummer 5555000011112222 is per direct beeindigd.",
    # Version strings, hashes and build numbers — IPAddress / secret shaped.
    "De release v2.14.3 is uitgerold naar de acceptatieomgeving.",
    "Build 2024.11.03 draait sinds gisteren zonder meldingen.",
    "De commit 3f9a2c1d8e7b4a6f5c3d2e1a0b9c8d7e6f5a4b3c is teruggedraaid.",
    "Loopback 127.0.0.1 en poort 8080 zijn lokaal geconfigureerd.",
    # Document/product codes shaped like passports and plates.
    "Typegoedkeuring AB1234567 geldt voor deze productserie.",
    "De ISBN 978-90-274-3964-4 hoort bij de tweede druk.",
    "Onderdeelnummer XY-99-ZZ is vervangen door een nieuwer model.",
    # Organisations and roles that are not people.
    "De gemeente Utrecht besloot het bestemmingsplan aan te passen.",
    "Het Rijksmuseum en de Raad van State reageerden op het voorstel.",
    "De werkgever, de verzekeraar en de gemachtigde waren aanwezig.",
    # Medical-adjacent common nouns that are not conditions or medication.
    "De conditie van het pand was matig, het dak vertoonde lekkage.",
    "Het medicijnkastje in de kantine moet worden bijgevuld.",
]


def build_taxid_templates(rng: random.Random) -> list[tuple[str, str, str]]:
    """Anchored KVK / RSIN templates as (template, lang, variant).

    TaxIdentificationNumber has three production shapes — BTW, KVK and RSIN —
    but the corpus only ever generated BTW, so the category's recall of 1.000
    was measured on a third of its surface. KVK and RSIN are the hard third:
    bare, they are just an 8- or 9-digit run, and the old regex tier only found
    them via a context anchor (plus, for RSIN, the elfproef).

    The value is generated here and spliced in with the inline ⟦…⟧ form so the
    identifier and its anchor phrase can never disagree — the failure mode that
    made BSN look broken.
    """
    out: list[tuple[str, str, str]] = []
    kvk, _ = vb.gen_kvk(rng)
    out.append(
        (
            f"Het KVK-nummer van de onderneming is ⟦TaxIdentificationNumber|{kvk}⟧.",
            "nl",
            "kvk_anchored",
        )
    )
    kvk2, _ = vb.gen_kvk(rng)
    out.append(
        (
            f"Ingeschreven in het handelsregister onder ⟦TaxIdentificationNumber|{kvk2}⟧ "
            f"te Amsterdam.",
            "nl",
            "kvk_anchored",
        )
    )
    rsin, _ = vb.gen_rsin(rng)
    out.append(
        (
            f"Het RSIN van de rechtspersoon luidt ⟦TaxIdentificationNumber|{rsin}⟧.",
            "nl",
            "rsin_anchored",
        )
    )
    rsin2, _ = vb.gen_rsin(rng)
    out.append(
        (
            f"Voor de fiscale eenheid geldt fiscaal nummer "
            f"⟦TaxIdentificationNumber|{rsin2}⟧.",
            "nl",
            "rsin_anchored",
        )
    )
    return out


# ── Corpus size ────────────────────────────────────────────────────────────
# Sized so the DECISION split can actually resolve a per-category regression.
# Before: 13 of 21 categories had 15-18 held-out spans, where one span moves
# recall 6.7pp while the CI tolerance is 0.02 — the gate was finer than the
# measurement, so most of the taxonomy was being gated on noise.
#
# The thin categories get 1 span per LARGE doc and only 1 per short template
# round, so `large_count` is the only effective lever (measured: at
# large_count=40 they sat at exactly 40 large + 5 short = 45 total). Target is
# >=60 held-out spans, i.e. >=200 total at a 30% held-out share.
#
# This is the dominant cost of a model-based eval run — raising it makes every
# `--split held-out` run proportionally slower. `--subset ci` exists so the
# per-PR gate does not pay it.
_SHORT_ROUNDS = 8
_LARGE_COUNT = 205
_NEG_ROUNDS = 4


def generate_corpus(seed: int) -> dict[str, list[Record]]:
    rng = random.Random(seed)
    short: list[Record] = []
    large: list[Record] = []
    negatives: list[Record] = []

    # Short — cycle templates a few times with fresh values.
    rounds = _SHORT_ROUNDS
    for r in range(rounds):
        for ti, (tmpl, tlang) in enumerate(_SHORT_TEMPLATES):
            text, spans = compile_template(tmpl, rng, tlang)
            rec = Record(
                id=f"short-{tlang}-{ti:02d}-{r}",
                text=text,
                spans=tuple(spans),
                lang=tlang,
                size_class="short",
                source="synthetic-template",
                meta={
                    "template": ti,
                    "seed": seed,
                    "round": r,
                    "categories_present": sorted({s.category for s in spans}),
                },
            )
            validate_record(rec)
            short.append(rec)

    # Short — the KVK / RSIN branches of TaxIdentificationNumber, anchored.
    for r in range(rounds):
        for ti, (tmpl, tlang, variant) in enumerate(build_taxid_templates(rng)):
            text, spans = compile_template(tmpl, rng, tlang)
            rec = Record(
                id=f"short-taxid-{variant}-{ti:02d}-{r}",
                text=text,
                spans=tuple(spans),
                lang=tlang,
                size_class="short",
                source="synthetic-template",
                meta={
                    "template": f"taxid-{ti}",
                    "seed": seed,
                    "round": r,
                    "taxid_variant": variant,
                    "categories_present": sorted({s.category for s in spans}),
                },
            )
            validate_record(rec)
            short.append(rec)

    # Large — multiple docs, several languages, deep-tail entities.
    large_count = _LARGE_COUNT
    for i in range(large_count):
        lang = rng.choice(["nl", "nl", "nl", "de", "fr", "es", "it", "en"])
        doc_type = rng.choice(_DOC_TYPES)
        tmpl = build_large_doc(rng, lang, doc_type)
        text, spans = compile_template(tmpl, rng, lang)
        deep = [s for s in spans if s.start > 1400]
        very_deep = [s for s in spans if s.start > 3000]
        rec = Record(
            id=f"large-{lang}-{i:03d}",
            text=text,
            spans=tuple(spans),
            lang=lang,
            size_class="large",
            source="synthetic-template",
            meta={
                "doc_type": doc_type,
                "seed": seed,
                "chars": len(text),
                "categories_present": sorted({s.category for s in spans}),
                "spans_past_1400": len(deep),
                "spans_past_3000": len(very_deep),
                "boundary_stress": [s.start for s in deep],
            },
        )
        validate_record(rec)
        large.append(rec)

    # Negatives — hard distractors, empty gold.
    neg_rounds = _NEG_ROUNDS
    for r in range(neg_rounds):
        for ti, tmpl in enumerate(_NEGATIVE_TEMPLATES):
            text = normalize(tmpl)
            rec = Record(
                id=f"neg-{ti:02d}-{r}",
                text=text,
                spans=(),
                lang="nl",
                size_class="short",
                source="synthetic-negative",
                meta={"template": ti, "seed": seed, "distractor": True},
            )
            validate_record(rec)
            negatives.append(rec)

    return {"short": short, "large": large, "negatives": negatives}


# Minimum gold spans per category for a per-category claim to mean anything.
# A Wilson interval at p≈0.97 needs n≈100 for roughly ±3pp; below ~40 the
# interval is so wide that "SAFE" and "REGRESSION" are indistinguishable.
# Generation FAILS below these — a silently under-sampled category is how a
# false "safe to ship" gets published.
#
# Raised from 40 with the corpus resize. 40 total meant ~15 in held-out, where
# ONE span moves recall 6.7pp and the CI tolerance is 0.02: the gate was finer
# than the measurement for 13 of 21 categories. The floor is expressed on the
# TOTAL because that is what generation controls, but the number that matters
# is the ~30% that lands in held-out — 180 total keeps every category above the
# ~60 held-out spans that gate() requires before it will gate at all
# (_MIN_GOLD_TO_GATE in eval/run_eval.py).
_MIN_SPANS_PER_CATEGORY = 180


def build_lock(corpus: dict[str, list[Record]], seed: int) -> dict:
    """Content summary used instead of a byte-diff to detect corpus drift.

    A byte diff does not scale: touching any value bank re-rolls every
    downstream RNG draw and rewrites 100% of lines, so the diff is unreviewable
    and tells you nothing. The histograms below are the part a reviewer
    actually needs — "PhoneNumber bare forms: 41 → 0" is a one-line diff that
    would otherwise hide inside 300 rewritten records.
    """
    import hashlib

    by_category: dict[str, int] = {}
    by_value_kind: dict[str, int] = {}
    files: dict[str, dict] = {}
    for name, records in corpus.items():
        h = hashlib.sha256()
        for r in records:
            h.update(r.text.encode("utf-8"))
            for s in r.spans:
                h.update(f"{s.start}:{s.end}:{s.category}".encode("utf-8"))
                by_category[s.category] = by_category.get(s.category, 0) + 1
                by_value_kind[s.value_kind] = by_value_kind.get(s.value_kind, 0) + 1
        files[name] = {
            "sha256": h.hexdigest(),
            "n_records": len(records),
            "n_spans": sum(len(r.spans) for r in records),
            "n_chars": sum(len(r.text) for r in records),
        }
    return {
        "seed": seed,
        "files": files,
        "spans_by_category": dict(sorted(by_category.items())),
        "spans_by_value_kind": dict(sorted(by_value_kind.items())),
        "min_spans_per_category": _MIN_SPANS_PER_CATEGORY,
    }


def assert_quotas(lock: dict) -> list[str]:
    """Return quota violations (empty == pass)."""
    from .schema import CANONICAL_CATEGORIES

    problems = []
    counts = lock["spans_by_category"]
    for cat in sorted(CANONICAL_CATEGORIES):
        n = counts.get(cat, 0)
        if n < _MIN_SPANS_PER_CATEGORY:
            problems.append(f"{cat}: {n} gold spans (< {_MIN_SPANS_PER_CATEGORY})")
    return problems


def main() -> int:  # noqa: C901
    ap = argparse.ArgumentParser(description="Generate the synthetic PII eval corpus.")
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "corpus"))
    ap.add_argument(
        "--check",
        action="store_true",
        help="regenerate in memory and compare to CORPUS.lock.json "
        "without writing (CI drift check)",
    )
    args = ap.parse_args()

    corpus = generate_corpus(args.seed)
    lock = build_lock(corpus, args.seed)
    lock_path = os.path.join(args.out, "CORPUS.lock.json")

    violations = assert_quotas(lock)
    if violations:
        print("QUOTA FAIL — categories below the minimum for a meaningful claim:")
        for v in violations:
            print(f"  - {v}")
        return 1

    if args.check:
        if not os.path.isfile(lock_path):
            print(f"no lock file at {lock_path}", file=sys.stderr)
            return 2
        with open(lock_path, encoding="utf-8") as fh:
            committed = json.load(fh)
        if committed != lock:
            print(
                "CORPUS DRIFT — regenerated corpus does not match CORPUS.lock.json",
                file=sys.stderr,
            )
            for name in sorted(set(lock["files"]) | set(committed.get("files", {}))):
                a = committed.get("files", {}).get(name, {}).get("sha256")
                b = lock["files"].get(name, {}).get("sha256")
                if a != b:
                    print(f"  - {name}: {a} -> {b}", file=sys.stderr)
            for cat in sorted(
                set(lock["spans_by_category"])
                | set(committed.get("spans_by_category", {}))
            ):
                a = committed.get("spans_by_category", {}).get(cat, 0)
                b = lock["spans_by_category"].get(cat, 0)
                if a != b:
                    print(f"  - spans[{cat}]: {a} -> {b}", file=sys.stderr)
            return 1
        print(f"corpus matches CORPUS.lock.json (seed={args.seed})")
        return 0

    os.makedirs(args.out, exist_ok=True)
    total = 0
    for name, records in corpus.items():
        path = os.path.join(args.out, f"{name}.jsonl")
        n = dump_jsonl(records, path)
        total += n
        spans = sum(len(r.spans) for r in records)
        chars = sum(len(r.text) for r in records)
        print(
            f"  {name:10s} {n:4d} records  {spans:5d} spans  {chars:7d} chars  -> {path}"
        )
    with open(lock_path, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(lock, fh, ensure_ascii=False, indent=2, sort_keys=True)
        fh.write("\n")
    print(f"total: {total} records (seed={args.seed})  -> {lock_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

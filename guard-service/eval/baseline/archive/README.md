# Archived baselines

Snapshots kept for historical comparison. Not gated against — see
`eval/baseline/` for the live baselines.

## `metrics_hybrid_baseline.pre-suppression-fix.json` (+ `metrics_regex_baseline.pre-nearmiss.json`, `metrics_off_baseline.pre-nearmiss.json`)

The state before the suppression-gate release: fresh baselines on the fixed
corpus, measured hours before the fixes landed, archived as the before-picture.
Headline hybrid: micro **P 0.9475, R 0.9283**, redaction_recall 0.9132.

What the release changed, each measured on held-out against these files:

1. **Unknown region suppresses conservatively.** `regex_complete_categories(None)`
   — what every `GUARD_PII_REGIONS=*` deployment runs — used to union every
   country's `complete` specs, so a Polish tenant lost the model for
   NationalIdentificationNumber because the NETHERLANDS has a BSN pattern.
   `None` now yields only the `_ANY`-region claims (six categories); the
   country-specific suppression must be EARNED by declaring the region.
2. **Completeness must be measured.** `eval/check_completeness` (CI, model-free)
   demands recall >= 0.90 AND >= the committed model recall − 0.02 for every
   claim. Its first catch: **PhoneNumber**, complete for `_ANY` while its regex
   measured 0.000 on 294/852 gold spans (bare Dutch mobiles, bare landlines,
   `0031…`, parenthesised NANP — that last one a live `\b(` bug, also fixed)
   against model recall 1.000. Demoted; the label group returned; phone recall
   went **0.684 → 1.000** at precision 0.9935 → 0.93 — the deliberate price of
   detecting a third of all phones at all.
3. **Demote-never-drop reached the regex tier.** `_apply_validators`' rule
   ("a Luhn failure on a typo'd card is still PII") was model-only — dead under
   `tier=on` for exactly the checksum-suppressed categories. Opt-in specs with
   DISTINCTIVE shapes (both IBAN forms, GROUPED card notation, dashed SSN) now
   emit checksum failures at confidence × 0.7 instead of dropping them. The
   boundary of "distinctive" was measured, not asserted: bare digit runs and
   short pseudo-IBAN codes would have fired on ~20% and ~13% of business-noise
   documents respectively — so cards demote only in 4-4-4-4/4-6-5 notation, and
   the IBAN body bound went 4..30 → **11..30** (ISO 13616 registers nothing
   under 15 chars total; the old bound admitted every "AB123456" reference
   code). A near-miss firing-rate ceiling (0.5% on the frozen noise corpus)
   pins the boundary in CI.
4. **The corpus carries the typo populations** (`iban_typo`, `cc_typo`,
   `ssn_bad_range` — gold-labeled, checksum-INVALID by contract) so the
   near-miss net is measured, not presumed: IBAN/CC/SSN recall on the new
   corpus is 1.000 including the typos, where the model alone measures IBAN at
   0.037.
5. **The Dutch polisnummer got its first detector** — the category that was
   invisible in EVERY mode (regex: no pattern; model R 0.07; calibration:
   policy_unreachable). Anchored on the shared health-insurance word list,
   therefore structurally never `complete`, therefore purely additive:
   HealthInsuranceNumber ended at **P 1.000 / R 0.959**.

Final (live) baselines against this archive, held-out:

| metric | before | after |
|---|---|---|
| micro P / R / F1 | 0.9475 / 0.9283 / 0.9378 | **0.9461 / 0.9814 / 0.9634** |
| redaction_recall | 0.9132 | **0.985** |
| leaked alnum chars | 1406 | **269** |
| PhoneNumber R | 0.684 | **1.000** |
| IBAN R (incl. typos) | — | **1.000** |
| HealthInsuranceNumber R | 0.456 | **0.959** |
| NL by_region R | — | **0.9906** |

The gate fired on four rows during the release, all inspected and explained
rather than tolerated: phone/natid precision (the model net's price), a TaxID
"recall drop" that was three RSIN/BSN label shuffles with redaction intact
(`label_only_failures` 0 → 5 while leaked chars fell 69%), and a control-group
move that was **upward** — BankAccountNumber R 0.51 → 0.84, mechanistically
attributable to G7's active-label composition changing when
LicensePlate/TaxID returned to it. That last one is worth remembering: the
frozen control group detects within-group composition changes, not only
chunking changes, and re-activating a suppressed category shifts its
group-mates. Explained ≠ exempt: the new baselines simply carry the better
numbers.

## `metrics_regex_baseline.pre-corpus-fix.json`

The regex tier measured against a corpus that could not see most of it.
Headline: micro **P 0.9793, R 0.8735**.

The previous entry closes by naming a known gap — the corpus generated its
non-Dutch national IDs as random digits, so the checksum-gated patterns for
BE/DE/FR/ES were "barely exercised". That was an understatement in two
directions, and closing it turned out to be the highest-value change available.
**Four** separate causes, none of them in the detector:

1. **The values were not well-formed.** Every non-Dutch national-ID spec is
   checksum-gated, so a random eleven-digit `natid_de` could not be detected by
   anything. The DE (0.565) and FR (0.563) numbers came entirely from licence
   plates and IBANs; the national-ID column was structurally zero and read as a
   quality problem. Values are now CONSTRUCTED against `eval/validators.py`.
2. **Four countries had no values at all.** The country pick was
   `by_lang.get(lang, rng.choice(pool))`, and the fallback was dead code — the
   corpus only emits nl/de/fr/es/it/en, every one of which is a key. BE, PL, SE
   and AT were never drawn, so four shipped detectors measured nothing and
   `by_region` had no row to be surprised by.
3. **Dutch documents could not contain a foreign identifier.** The branch was
   gated on `lang != "nl"`, which excluded three quarters of the corpus from
   ever exercising a foreign pattern — and is false besides: a Dutch care
   provider writes Dutch prose about a Polish employee's PESEL.
4. **The anchor gap was separators-only.** `[\s:#\-]{0,10}` meant the keyword
   had to be effectively adjacent, so "BSN: X" anchored but "Het BSN is X" did
   not. Every missed PESEL and SVNR was a value whose keyword was present and
   one prose word too far away. Now `[^0-9]{0,25}` — bounded, and the digit
   exclusion stops a keyword reaching past one number to claim another.

Measured, `pre-corpus-fix` → live:

| region | before | after | |
|---|---|---|---|
| FR | 0.563 | **1.000** | |
| ES | 0.600 | **1.000** | |
| DE | 0.565 | **0.941** | |
| GB | 0.330 | 0.397 | still no GB patterns shipped |
| NL | 0.773 | 0.781 | |
| US | 0.812 | 0.804 | |
| BE | — | **1.000** | not previously measurable |
| SE | — | **1.000** | not previously measurable |
| AT | — | **0.929** | not previously measurable |
| PL | — | **0.857** | not previously measurable |

Micro **P 0.9793 → 0.9819, R 0.8735 → 0.9055**. Precision moved up, and the
hard-negatives split was checked span-by-span before and after the anchor
change: **zero** added false positives.

The live baseline then took the UK and Germany ports on top, ending at
**P 0.9889, R 0.9307**. Final per-region against this file:

| region | before | after | |
|---|---|---|---|
| GB | 0.330 | **0.995** | Presidio port: NINO, NHS, vehicle reg, DVLA licence, passport |
| FR | 0.563 | **1.000** | |
| ES | 0.600 | **1.000** | |
| DE | 0.565 | **0.985** | Presidio port: RVNR, KVNR, Steuernummer, Handelsregister |
| BE / SE | — | **1.000** | not previously measurable |
| AT / PL | — | **0.833** | not previously measurable |
| NL | 0.773 | 0.696 | see below — an attribution change, not a regression |
| US | 0.812 | 0.807 | |

**NL is not a regression.** `health_ins` became `health_ins_nl`, which moved 145
Dutch policy numbers out of the region-neutral bucket and into NL. They have no
checksum and no fixed layout, so nothing detects them and nothing can — a true
statement about the category that was previously filed under "any". Every NL
category that HAS a pattern scores 0.98-1.00; the two at zero are
DriversLicenseNumber (n=162) and HealthInsuranceNumber (n=145), both
model-only by design.

Two defects were found by measurement rather than by review, and both were
older than this work:

* **The German RVNR pattern could not match a German social-security number.**
  It was written `\d{2}[A-Z]\d{6}[A-Z]\d{3}` — two letters, in the wrong
  positions. A real Rentenversicherungsnummer has one, at position 9. The spec
  had never matched anything real and could only produce false positives. The
  corpus never caught it because the corpus never contained an RVNR either.
* **A spaced IBAN was not detected at all.** `_IBAN_RE` cannot match across a
  space, so `NL59 RABO 2654 2351 16` — the way every bank prints one — produced
  nothing, while the generic phone pattern matched fragments of the same string.
  An unredacted bank account, with a piece of it mislabelled as a telephone
  number. Fixing the IBAN side moved IBAN recall **+17.0pp** and PhoneNumber
  precision **+5.8pp** in one change, because they were one bug.

One detector change rode along, because the corpus fix exposed it and would
otherwise have measured nonsense. `_pick_label` ordered contenders by margin
above the category floor — sound for model spans, meaningless for deterministic
ones, where every candidate carries the same constant and the comparison
collapses to "lowest floor wins". PhoneNumber (0.35) and CreditCardNumber (0.40)
sit below NationalIdentificationNumber (0.45), so a Swedish personnummer was
emitted as `[phone_1]` and a French NIR that satisfies Luhn — one in ten do — as
`[credit_card_1]`. Equal confidence now falls through to extent, then to the
frozen precedence table. On the corpus of the time that change was
byte-identical; it only bites where the corpus previously could not look.

## `metrics_regex_baseline.pre-regions.json`

The regex tier when every country-specific pattern in it was Dutch: BSN, RSIN,
KVK, BTW, the six RDW sidecodes, the Dutch passport shape and Dutch titled
persons, plus the country-neutral ones (email, IBAN, Luhn, IP, URL, secrets) and
the US SSN.

Headline: micro **precision 0.9795, recall 0.5417**.

Why it was replaced. `REGEX_COMPLETE_CATEGORIES` tells `pii.py` to stop asking
GLiNER about a category, and it was a hand-written global list. So a tenant
outside the Netherlands had **neither** detector for their own identifiers: the
model was suppressed for NationalIdentificationNumber, TaxIdentificationNumber
and LicensePlateNumber, and the pattern behind each could only match a Dutch
value. Nothing in this file shows that, which is the point — every view is
bucketed by category, and the categories looked fine.

The live baseline adds nine countries (BE, DE, FR, ES, IT, PL, SE, AT, US),
computes completeness **per active region**, and adds a `by_region` block so the
question is answerable. Measured with `--regions NL` (which reproduces this
file's pattern set) against the default all-regions run:

| region | NL-only | all regions | Δ recall |
|---|---|---|---|
| IT | 0.400 | 1.000 | **+0.600** |
| US | 0.000 | 0.812 | **+0.812** |
| DE | 0.337 | 0.565 | **+0.228** |
| FR | 0.352 | 0.563 | **+0.211** |
| ES | 0.415 | 0.600 | **+0.185** |
| NL | 0.773 | 0.773 | 0.000 |
| GB | 0.330 | 0.330 | 0.000 (no GB patterns shipped) |

NL is unchanged by construction and that is the guarantee worth checking on any
future region change. Micro precision moved **up** (0.9795 → 0.9803), because
the one pattern that cost precision — a Spanish phone shape with optional
separators, which reduced to "any nine digits starting 6-9" and swallowed Dutch
BSNs — was caught by the gate and fixed before this baseline was taken.

Known gap, deliberately recorded rather than hidden: the corpus generates its
non-Dutch national IDs as random digits (it predates these checksums), so the
checksum-gated patterns for BE/DE/FR/ES national IDs are barely exercised by
`natid_*` spans. The DE and IT gains above come from plates and IBANs. Making
those corpus values checksum-valid — and adding PL/SE/AT values at all — is
outstanding work; until it lands, `by_region` understates national-ID coverage.

## `metrics_regex_baseline.pre-hardening.json`

The regex tier measured against the corpus **as it stood before the Phase 2
hardening** (211 records / 1,370 gold spans / 173k chars).

Headline: `by_tier.regex` micro **precision 0.9959, recall 1.0000, F1 0.9980**
— 735 true positives, 3 false positives, **zero** false negatives.

**That recall of 1.0000 was a tautology, not a measurement.** The corpus
generator built its values by importing the regex tier's own validators, and
`test_deterministic_values_pass_service_validators` asserted that every
generated value was detected by `detect_regex_pii`. The corpus could therefore
only ever contain values the regex tier already found. It was not possible for
that number to be anything other than ~1.0.

What changed in the hardening (same detector, no code change to `pii_regex.py`):

| category | pre-hardening | post-hardening | why |
|---|---|---|---|
| PhoneNumber | 1.0000 | 0.5889 | `gen_phone` only emitted separated / `+`-prefixed forms. Adding the bare `0644137044` — the most common way a Dutch user types a mobile, and the bug that started this work — exposed that `_PHONE_RE` requires a separator. |
| TaxIdentificationNumber | 1.0000 | 0.7692 | The corpus only contained BTW (`NL#########B##`). Adding the KVK and RSIN branches behind natural phrasing ("Het KVK-nummer van de onderneming is …") defeats the anchor, which must sit within 10 separator chars of the number. |
| micro F1 (regex tier) | 0.9980 | 0.9205 | the two above |

So this file is the honest record of **what the regex tier could do on
questions it was guaranteed to be able to answer** — useful as the "what are we
giving up" reference for the GLiNER-only cutover, and useless as a quality bar.

Keep it. Once `app/services/pii_regex.py` is deleted these numbers can never be
regenerated, and the go/no-go argument refers to them.

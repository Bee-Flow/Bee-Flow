# PII detection eval & calibration harness

Measures PII-detection quality across all 21 categories — especially over
**large text where many categories co-occur** — so quality is regression-gated
instead of hand-tuned from anecdotes. Everything except the model-based run
modes is pure stdlib (no numpy/sklearn), so it runs inside the guard container
and model-free in CI.

## Layout

| File | Role |
|------|------|
| `schema.py` | record/span dataclasses, JSONL loader, load-time self-checks (`text[s:e]==span.text`, 21-ID, non-overlap, NFC) |
| `value_banks.py` | locale value banks + generators built on `eval/validators.py` — deterministic values provably pass detection while being non-real |
| `validators.py` | the five checksums, VENDORED so the corpus is not defined by the detector under test |
| `generate_corpus.py` | template (`{{Category}}`) + inline-annotation (`⟦Category｜value⟧`) compiler; offsets computed at splice time |
| `corpus/{short,large,negatives}.jsonl` | checked-in synthetic gold data (no real PII) |
| `categories.py` | the canonical 21 + the class maps (`by_prior_owner` / `by_structure` / `by_risk`) and `CONTROL_GROUP` |
| `matcher.py` | strict + IoU(≥0.5) one-to-one greedy span matching |
| `metrics.py` | P/R/F1/F2, micro/macro, breakdowns by size/lang/tier/**class**, confusion, boundary quality, control group |
| `leak.py` | the SAFETY view: `redaction_recall` vs `label_recall`, `partial_leak_rate`, `over_redaction_rate` |
| `run_eval.py` | CLI: `--tier {hybrid,off,regex}` / `--endpoint`, writes `metrics.json`, gates against a baseline |
| `calibrate.py` | low-floor sweep over **pre-`_finalise` candidates** → proposed per-category floors |
| `baseline/metrics_regex_baseline.json` | model-free regex-tier baseline the CI gate compares against |
| `baseline/metrics_hybrid_baseline.json` | what production does TODAY (regex + model). **Cannot be regenerated once `pii_regex.py` is deleted** — and currently **STALE**: it was measured against the pre-corpus-fix corpus, so its numbers are not comparable to anything produced now. Regenerating needs the 2.5 GB model. Nothing gates against it (CI looks for `metrics_model_baseline.json`), so this is a reading hazard rather than a broken build. |

## Reading a report

`overall` is the headline, but the cutover decision is read off two derived views:

* **`by_class.by_structure`** — `structured` vs `fuzzy`. This is the axis the
  decision turns on: models are weakest on checksummed structured identifiers
  and strongest on fuzzy high-sensitivity categories, so a single micro number
  averages away the thing you are trying to see.
* **`leak`** — `redaction_recall` is "did the characters actually get removed",
  which is the product truth. `label_recall` can collapse while
  `redaction_recall` stays ~1.0: the value *was* redacted, under the wrong token
  name. Measured on this corpus, IBAN once scored label-recall 0.094 against
  redaction-recall 0.988. Reporting either alone would have been wrong.
* **`control_group`** — categories the change was not supposed to touch. If they
  moved, the chunking moved underneath the run (label groups → prompt length →
  text token budget) and no other row is trustworthy until that is explained.

## Commands (run from `guard-service/`)

```bash
# Regenerate the synthetic corpus (deterministic; seed baked in)
python -m eval.generate_corpus --seed 42

# Model-free: regex tier only (what CI runs — no 2.5 GB model)
python -m eval.run_eval --regex-only --gate-tier regex \
    --baseline eval/baseline/metrics_regex_baseline.json

# What production does TODAY (regex + model)
python -m eval.run_eval --tier hybrid --split held-out \
    --out eval/baseline/metrics_hybrid_baseline.json

# What the cutover ships: MODEL-ONLY. Flips the real GUARD_PII_REGEX_TIER
# switch in-process, so this measures the shipped configuration and not an
# approximation of it.
python -m eval.run_eval --tier off --split held-out --timing --out eval/metrics.off.json

# ...with the BSN elfproef candidate generator removed as well — no arithmetic
# proposes anything anywhere. The delta between this and the line above is the
# measured price of the strict "only the model detects" rule.
python -m eval.run_eval --tier off --bsn off --split held-out

# Propose recalibrated per-category floors (review the PR curves before committing)
python -m eval.calibrate --split calibrate --tier off

# Harness unit tests (model-free) — includes the gate's own regression tests
python -m unittest tests.test_eval_harness tests.test_pii
```

### Splits
Records are bucketed deterministically by a sha256 of their id:

| split | buckets | use |
|-------|---------|-----|
| `calibrate` | 0–49 | fit per-category floors |
| `dev` | 50–69 | choose label groups, sanity-check a calibration |
| `held-out` | 70–99 | the decision run — spent once, at the go/no-go |

`--subset ci` takes a deterministic ~30% sample **within** the chosen split, for
a fast model-based gate. It uses an INDEPENDENT hash: while it shared the split
hash, `--subset ci --split held-out` intersected two disjoint bucket ranges and
returned zero records, so the documented fast gate could not run at all.

### Corpus size
Sized so a per-category verdict on `held-out` can resolve a real regression:
every category carries ≥60 held-out gold spans. At the previous size 13 of 21
categories sat at 15–18, where one span moves recall 6.7pp while the CI
tolerance is 0.02 — the gate was finer than the measurement. `gate()` now
refuses (loudly) to gate any category below `_MIN_GOLD_TO_GATE` rather than
report noise as a verdict.

### Tier modes
`--tier off` sets `settings.pii_regex_tier` rather than patching
`detect_regex_pii` out of the module. This is not a style preference:
`detect()` also gates the BSN checksum carve-out on `tier_mode == "off"`, so
patching only the regex module measured the model **without** the BSN validator
while reporting it as the shipped `off` config. Every run asserts the
`tier_mode` the service actually reported back (`meta.observed_tier_mode`) and
fails if it differs from the one requested.

## Updating the baseline
Regenerating a baseline is a deliberate, reviewed commit (like a snapshot
update). After an intended quality change:
```bash
python -m eval.run_eval --regex-only --gate-tier regex \
    --out eval/baseline/metrics_regex_baseline.json    # model-free CI baseline
python -m eval.run_eval --split held-out \
    --out eval/baseline/metrics_baseline.json          # full model-based baseline
```

## Privacy / secret-scan note
All values are synthetic and drawn from documentation/reserved ranges (RFC 5737
IPs, reserved BSN/IBAN check-digit construction, standard Luhn test PANs). The
`ApiKeyOrSecret` samples in `corpus/*.jsonl` are **fake test fixtures** that
match the guard's secret regex — allowlist `guard-service/eval/corpus/` in the
repo secret-scan (`scripts/scan-secrets.sh`) if it flags them.

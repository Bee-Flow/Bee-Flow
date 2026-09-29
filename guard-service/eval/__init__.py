"""PII detection evaluation & threshold-calibration harness.

A measurement layer over ``app.services.pii`` so PII-detection quality across
all 21 categories — especially over LARGE text where many categories co-occur —
is measurable and regression-gated instead of hand-tuned from anecdotes.

Layout:
  schema.py         record/span dataclasses + JSONL loader + self-checks
  value_banks.py    locale value banks + validator-backed synthetic generators
  generate_corpus.py template/inline-annotation compiler -> corpus/*.jsonl
  matcher.py        strict + IoU one-to-one span matching
  metrics.py        precision/recall/F1/F2, micro/macro, breakdowns (pure stdlib)
  run_eval.py       CLI: in-process / --endpoint / --regex-only, baseline gate
  calibrate.py      low-floor sweep -> proposed per-category floors

Everything except the model-based run modes is pure stdlib so it runs in the
guard container (no numpy/sklearn) and model-free in CI.
"""

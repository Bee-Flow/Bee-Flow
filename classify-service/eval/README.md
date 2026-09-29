# "Is about" classifier eval

Chooses and calibrates the zero-shot model behind the **is about** operator in
the Automations Condition node, by measurement. An author writes
`Body` → is about → "a complaint". At run time an item (an email, a file name,
a file's text or a form answer, in Dutch or English) is scored against every
label in that node. It goes down every output at or above the threshold, and
to "otherwise" when none is reached.

The decision, and the rule it was held to, are in
[`MODEL-DECISIONS.md`](MODEL-DECISIONS.md). The rule was written before the
first run.

## Layout

| File | Role |
|------|------|
| `corpus/items.dev.jsonl` | 120 synthetic items. Every threshold and every probe is chosen on these |
| `corpus/items.heldout.jsonl` | 80 synthetic items, scored **once**, at the thresholds chosen on dev |
| `corpus/labelsets.json` | One label set per kind (5 to 7 labels), each as `en` / `bare` / `nl`, plus 2 distractors per kind |
| `corpus/check_corpus.py` | Checks ids, fields, gold labels and the quotas below. Stdlib only |
| `metrics.py` | Macro/micro F1 (also F2 and F0.5), the threshold sweep, top-1, the no-label false-positive rate, and the breakdowns. Stdlib only |
| `adapters/` | One module per candidate: `load()`, `tokenizer()`, `scores(texts, labels)` |
| `common.py` | Truncation at token edges (`head`, `head_tail`, `full`), provenance, and `/proc` memory readings |
| `run_eval.py` | Scores one model on one split, writing `results/<model>.<split>.json` |
| `bench.py` | CPU latency, throughput, load time and peak RSS, writing `results/<model>.bench.json` (and `.memory.json`) |
| `requirements-eval-{gliclass,gliner2,nli}.txt` | One environment per package. gliclass needs transformers 5; gliner2 needs transformers <5 |
| `../tests/test_eval_metrics.py` | Unit tests for `metrics.py`. No model, no torch |

Candidates on the command line: `gliclass` (gliclass-multilang-mini),
`gliclass-edge`, `gliner2` (GLiNER2.5-multi-Decide) and `nli`
(bge-m3-zeroshot-v2.0-c). `gliclass-edge` runs in the gliclass environment.

## Running

CPU only. There is no GPU anywhere, and every adapter uses `device='cpu'`
with the CPU build of torch. Run each model in its own container, limited the
way production is:

```bash
cd classify-service/eval
MODEL=gliclass ENV=gliclass     # or: gliclass-edge/gliclass, gliner2/gliner2, nli/nli
docker run --rm --cpus 3 --memory 4g \
  -v "$PWD":/eval -v "$HOME/.cache/huggingface":/root/.cache/huggingface \
  -w /eval python:3.12-slim sh -c "
    pip install -q -r requirements-eval-$ENV.txt &&
    python run_eval.py --model $MODEL --split dev &&
    python bench.py --model $MODEL &&
    python bench.py --model $MODEL --memory-sweep 1,2,4,8"
```

On a host where the root filesystem is tight, keep everything off it. Mount a
tmpfs-backed venv at `/venv`, set `HF_HOME`, `PIP_CACHE_DIR` and `TMPDIR` to
mounted tmpfs paths, and add `--read-only --tmpfs /tmp`. Then run
`python -m venv /venv && /venv/bin/pip install --no-cache-dir -r ...` once
and `/venv/bin/python ...` after that. That is how the committed results were
produced.

Every model is loaded from `snapshot_download(id, revision=<sha>)`, so a
result always names the exact weights it measured. The shas are pinned in the
adapters.

**Held-out, once, for the finalist only**, after dev has fixed the threshold:

```bash
python run_eval.py --model gliclass --split heldout
```

It reads `best`, `loose` and `strict` from `results/<model>.dev.json` and
refuses to run without that file. It never picks a threshold of its own.

Model-free checks:

```bash
python corpus/check_corpus.py                  # from classify-service/eval/
python -m pytest classify-service/tests/test_eval_metrics.py   # from the repo root
```

## What a results file holds

- `results` holds the full sweep (0.05 to 0.95, step 0.05), `best_threshold`
  (max macro-F1, ties to the one closest to 0.5), `loose_threshold` (max
  macro-F2) and `strict_threshold` (max macro-F0.5). It also has `at_best` and
  `at_0_5`, top-1 accuracy on the single-label items, and the breakdowns by
  language, by kind and per class.
- `probes` exists on dev only:
  - `label_set_sensitivity`: two distractors added per kind. It records how far
    the gold scores move and how many routing decisions flip.
  - `label_phrasing`: "complaint" vs "a complaint". Also Dutch labels on every
    item, reported for the Dutch items, the English items and the whole set,
    because a node labelled in Dutch still receives English mail. The NLI
    model uses a Dutch hypothesis template here.
  - `truncation`: the long emails as head 512, head 384 + tail 128, and the
    full text.
  - `independent_labels`: each label scored alone, one pass per label (the
    service's `label_mode="independent"`), with its cost per item. It is
    skipped for the NLI model, which is independent by construction.
  - Every probe carries `macro_f1_by_threshold`, the whole curve for the
    headline and for the variant.
- `provenance` and `env` record the model id and revision, package versions,
  CPU model, cgroup CPU quota and memory limit, torch threads and the date.
- `items` holds every score for every item, so a threshold can be re-read
  without the model.

A class is a (kind, label) pair. Macro-F1 averages the classes with at least
one gold item in the split.

## Corpus contract

Checked by `check_corpus.py`:

- About 55% Dutch and 45% English.
- About 20% of items carry more than one gold label, and about 15% carry none.
- At least 12 long emails. Every one of them is more than 512 tokens with both
  the mDeBERTa and the XLM-R tokenizer, and all of them are more than 2,000
  characters.
- Every label is gold at least twice in each split.
- Ids and texts are unique across the two splits.

Every item is synthetic and written for this eval: no customer data, no real
people. Addresses, amounts, IBANs (`NL00 …`, which is never a valid check
digit) and domains (`example.*`) are made up.

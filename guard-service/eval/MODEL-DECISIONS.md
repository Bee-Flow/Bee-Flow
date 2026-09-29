# Model-track decisions — measured, never benchmark-believed

Every verdict below was produced by this repo's own eval harness on the
current corpus lock; no external benchmark number appears in any decision.
Evidence files are committed next to the baselines.

## 2026-09-26 — custom labels (org-defined, zero-shot) and `/pii/probe`: ADOPT

**Verdict: ADOPT.** A request without `custom_labels` is **bit-identical**:
`eval/metrics.off.dev.custom-noop.json` against `eval/metrics.off.dev.g0229.json`
has zero differences outside `meta`. With custom labels, the built-in `entities`
AND the envelope were identical on all 131 dev records, in `off` and in `on`,
with two short labels (which share the shipped chunks) and, in `off`, with six
60-character labels (which get their own chunk list: 355 chunks against 316).

How it was measured: the `guard-eval:g0229` image no longer existed, so the
g0229 pins (gliner 0.2.29, transformers 5.16.1, tokenizers 0.23.2,
huggingface_hub 1.33.0, onnx 1.23.0, onnxruntime 1.30.0) were installed
`--no-deps` into a `PYTHONPATH` overlay on `guard:dev` (torch 2.14.0+cpu, graph
`4ab9f474…`), with `--cpus=8 --network none`. A control run of the PRE-change
tree on that overlay also gave zero differences against g0229, which is what
makes the overlay a valid stand-in for the image.

The mechanism: gliner 0.2.29 takes a `{id: prompt}` mapping as the label set
and returns the id. On the ONNX backend the scores equal a plain-list run of the
same prompts at 4 decimals. The custom labels run as ONE extra label group,
queued after the shipped ones and collected into a separate list, in canonical
(id-sorted) order, because the order is part of what the model reads.

Prompt width, measured with the shipped tokenizer (framing included: one
`<<ENT>>` per label plus `<<SEP>>`): the widest shipped set is 25 tokens (the
national-id group), text budget 349. Six 60-character prompts are 69 + 7 = 76
tokens, so their group gets a text budget of 349 - (76 - 25) = 298.

Cost: one extra pass per chunk. Mean ms per dev record, sequential, 8 cores:
two labels 1,799 -> 2,063 (`off`, +15%) and 1,761 -> 2,017 (`on`); six wide
labels 1,680 -> 1,962 (`off`, +17%).

## 2026-09-26 — gliner 0.2.29, its runtime API, `inference()`, pinned transitive stack: ADOPT

**Verdict: ADOPT.** Detection is **bit-identical**: `eval/metrics.off.dev.g0229.json`
against `eval/metrics.off.dev.g0228-head.json` (local, like every gitignored
`eval/metrics.*.json`; only `eval/baseline/` is tracked) has zero differences outside `meta`
(every category, boundary, region, leak and control-group number). Both runs used
the same graph, `--cpus=8`, `--network none`, and mounts verified by sha256 inside
and outside the container. CI's own gate (`--subset ci --split calibrate` against
`metrics_model_baseline.json`) also passes.

| | control | adopted |
|---|---|---|
| code | HEAD (0.2.28 spelling) | this change |
| gliner / transformers / tokenizers | 0.2.28 / 5.13.1 / 0.22.2 | 0.2.29 / 5.16.1 / 0.23.2 |
| onnxruntime / torch | 1.29.0 / 2.14.0+cpu | 1.30.0 / 2.14.0+cpu |
| graph sha256 | `4ab9f474…` | `4ab9f474…` |
| eval throughput | 1,328 chars/s | 1,307 chars/s |

**A bare version bump breaks the guard.** 0.2.29 rejects `low_cpu_mem_usage` for an
external runtime (`ValueError: low_cpu_mem_usage only apply to the PyTorch runtime`),
and the old loader passed it on the ONNX path. That was reproduced: the old loader on
0.2.29 never becomes ready, which on a fail-closed org means blocked chat. The flag
was already a no-op on that path under 0.2.28, so dropping it costs nothing. The
"~2x faster cold start" never applied to the backend we ship.

What changed in code: `runtime="onnxruntime"` + `runtime_model_file` +
`runtime_options` (the 0.2.29 spelling; `load_onnx_model`/`onnx_model_file` are its
legacy aliases); `local_files_only=True` for the baked dir (0.2.29 propagates it to
every load; both backends verified to load under `--network none`);
`GLiNER.inference(..., flat_ner=True, batch_size=len(texts))` instead of the
deprecated `batch_predict_entities`, which forwarded with batch_size 8; the gliner
version in the engine fingerprint. Both batching traps recorded at `_MODEL_BATCH_SIZE`
are fixed upstream, which was re-checked on the shipped model.

**Latency: no measurable difference.** Alternating single-pass benches at 8 cores,
25 reps each: old 137 / 160 / 192 ms, new 140 / 141 / 174 ms. The drift between
rounds of the SAME image exceeds any old/new gap. Concurrency 4 (one run each):
151 → 134 ms/pass. Measured on a 32-core dev box under `--cpus=8`, not on a PRO2 node.

**The gate-reading lesson, second edition.** The first gate run compared against
`metrics.off.dev.g0228.json` and FAILED: Person P 0.7939 → 0.779, TaxID P 1.0 → 0.96.
The control above reproduces both numbers exactly on 0.2.28, so neither was the
upgrade. g0228 was measured on the 2026-07-31 tree; code changes since, including
the 2026-08-01 word-boundary repair that moved Person to 0.779 / 59 FP, are in
every run of today's tree. **Rule:** gate a library bump as SAME CODE, old stack vs
new stack. A dated baseline file also compares everything that changed in the code
since its date. `metrics.off.dev.g0228-head.json` is the dev-split reference for the
current tree.

**Ungated drift, now closed.** Every baseline records graph `eca84d27…` (torch 2.13,
transformers 5.6.2). The `guard:dev` image shipped `4ab9f474…` (torch 2.14,
transformers 5.13.1): torch, transformers and tokenizers were unpinned, and a
rebuild moved them without a gate run. The 0.2.29 export is byte-identical to
0.2.28's under the same torch, so the graph change is torch's exporter, not gliner.
The control run above is a measurement OF the graph dev ships, but no run compared
`eca84d27…` against `4ab9f474…` on the same code. transformers, tokenizers,
huggingface_hub (requirements.txt) and torch (Dockerfile) are now exact pins.

**Bench trap.** `python /app/scripts/bench_passes.py` could not import `app`, so it
silently sized ORT for the host's 32 cores inside an 8-core quota: 1,294 ms/pass
instead of ~150. Fixed in the script. The 2026-07-31 numbers were taken via stdin,
which does not hit this.

## 2026-08-01 — span-shape filters + word-boundary repair: ADOPT, and a gate-reading lesson

Two detection changes, both driven by a pasted meeting transcript rather
than by the corpus: `_precision_filter` (a phone number has ≥7 digits; a US SSN
has 9) and word-edge repair in `_postprocess_entities` (a chunk opens on a
SUBWORD token, so a name like "Theodorus van der Brug" could come back as
"dorus van der Brug").

**Verdict: ADOPT.** `eval/run_eval.py --tier hybrid --split dev --gate-tier all`
against `eval/metrics.hybrid.dev.fresh.json` — **GATE: PASS**, control group
P 0.973 / R 0.970.

Measured effect, from a controlled A/B on the same split (changes on vs
neutralised at module level — the only honest way to attribute a delta):

| | off | on |
|---|---|---|
| Email recall | 0.9959 | **1.0000** |
| PhoneNumber recall (fp) | 0.9948 (19) | **1.0000** (18) |
| CreditCardNumber precision | 0.9400 | **0.9592** |
| Person precision (fp) | **0.7939** (54) | 0.7790 (59) |
| micro F1 | 0.9604 | 0.9601 |

So it is a real trade, not a free win: clipped Email/Phone spans get repaired,
and five extra Person false positives appear because a widened span can lose its
IoU match. Net micro-F1 is flat and the gate's tolerances hold, so it ships —
but Person precision is the thing to watch if this is ever widened.

**The lesson, and it is the expensive part.** The first run of this gate
reported eight failing rows including `redaction_recall` through its floor. All
eight were an artefact of comparing a **dev-split** run against
`metrics_hybrid_baseline.json`, which `meta.split` records as **held-out**. Two
different corpora. A control run with both changes neutralised reproduced the
same eight rows exactly, which is what proved it.

Cost of not checking first: a wrong diagnosis ("the digit floors broke
HealthInsurance recall"), a code change made for that wrong reason, and false
measured claims written into source comments — since corrected. Same class as
the mount-mangling incident below: the harness answered a question that was not
the one being asked, and it looked authoritative doing it.

**Rule:** before believing a gate result, check `meta.split` and `meta.tier` of
the BASELINE against the flags of the run. The corpus-lock gate cannot catch
this — both splits share one lock. Baselines on disk today:
`metrics_hybrid_baseline.json` (held-out), `metrics_off_baseline.json`
(held-out), `metrics_regex_baseline.json` (all), `metrics_model_baseline.json`
(calibrate), `metrics.hybrid.dev.fresh.json` (dev — the right partner for a
`--split dev` hybrid run).

## 2026-07-31 — throughput track: cores ADOPT, batching REJECT, concurrent passes ADOPT

Three verdicts from one measurement session, all with `scripts/bench_passes.py`
against the shipped model in the running container (one ~366-token chunk,
p50 of 5-7 timed reps after a discarded warm-up). Latency work, so the harness
here is the bench, not the eval corpus; the eval gate still guards detection.

**1. CPU quota — the dominant term, and it was configuration.**

| `cpus:` | intra_op | ms/pass |
|---|---|---|
| 3 | 3 | ~940 |
| 8 | 2 | 766 |
| 8 | 4 | 536 |
| 8 | **8** | **377** |
| 8 | 12 | 508 |
| 8 | 16 | 708 |

The knee sits exactly on the cgroup quota, which is what `intra_op =
available_cpus()` already computes — no code change, and the existing
derivation is vindicated. Threads scale SUBLINEARLY (4x threads → 2.03x speed),
which is the fact the rest of this entry turns on.

Also measured and **rejected**: pinning `OMP/MKL_NUM_THREADS` to 1 to stop them
double-counting against ORT's pool. 377.7 ms vs 376.7 ms — inside noise. Modern
ORT genuinely uses its own Eigen pool. Not worth a change.

**2. Batching rows into one call — REJECT.** Per-row ms at 8 cores: 1697 / 1591
/ 1501 / 1547 at widths 1-4, i.e. ≤13% and non-monotonic. One sequence already
saturates the quota, so a wider batch buys padding, not parallelism. This
re-tests the note in `pii.py` that said to revisit `_MODEL_BATCH_SIZE` at higher
core counts: revisited, unchanged. Full mechanism and the two traps for anyone
who tries again (equal label widths; `batch_size >= len(texts)`) are recorded at
`_MODEL_BATCH_SIZE`.

Worth recording because it is not obvious: per-item label sets **do** work in
0.2.28 (`prepare_batch`'s `List[List[str]]` branch) and produce **bit-identical**
scores to sequential calls — verified to four decimals. A ragged (3,5) batch
raises `KeyError: 4`, because `UniEncoderSpanModel` applies
`prompts_embedding_mask` only inside `loss()` so the exported graph scores
zero-padded prompt slots, and `SpanDecoder` indexes `id_to_class[idx + 1]`
without `.get()`. So label-group bucketing would have been *correct* — it is
simply not *faster*.

**3. Concurrent forward passes — ADOPT.** Since threads scale sublinearly,
issuing several passes at once beats giving one pass more threads. At an 8-core
quota with `intra_op` left at 8:

| workers | ms/pass |
|---|---|
| 1 | 395 |
| 2 | 339 |
| 4 | 311 |
| 8 | **294** |

1.35x, and — the reason this configuration was chosen over the faster-looking
one — **single-pass latency is unchanged at 395 ms**, because concurrent
`Run()` calls share one ORT intra-op pool rather than each spawning their own.
The alternative (`intra_op=1` x 8 workers) measured 253 ms/pass but makes a
one-pass scan ~3x slower, which is a bad trade for short chat messages.

Shipped as `pii_inference_lock="tokenizer"` + `pii_predict_workers`, with
`GUARD_PII_INFERENCE_LOCK=global` as a restart-only kill switch. The lock could
be narrowed because the "Already borrowed" hazard was never in `Run()` — ORT is
thread-safe on the CPU EP — but in `transformers._set_truncation_and_padding`,
which mutates the Rust tokenizer on every call. Per-thread tokenizers remove
the sharing; `tests/test_pii_concurrency.py` pins zero borrow violations, real
observed concurrency, and the kill switch.

**End-to-end, at 8 cores, tier=on (6 label groups), transcript-shaped text:**
2k chars → 4.6 s, 8k → 18.2 s, 25k → 58.9 s. Linear at ~385 ms/pass. The
remaining large lever is the label-group count, which is a *quality* trade and
belongs to the eval gate, not to this entry.

## 2026-07-31 — gliner 0.2.28 + `low_cpu_mem_usage`: ADOPT

Pinned `gliner==0.2.28` in requirements.txt. Evidence:
`eval/metrics.off.dev.g0228.json` — equivalence gate **PASS at tol 0.01**
against the fresh off-tier dev baseline, measured on the WORKING TREE with
mount verification in the launch script (`mount | grep ' /app/eval type 9p'`
— a first run without that check was invalidated by the mount-mangling
incident below and re-run). The `low_cpu_mem_usage=True` loading path is in
`pii.py` (accepted by 0.2.27 and 0.2.28 alike; ~2x faster cold start per
upstream, which matters because fail-closed deployments block chat until
/ready). Note for the future: `batch_predict_entities` is deprecated upstream
in favour of `GLiNER.inference` — migrate deliberately, with this same gate,
never as a drive-by.

## 2026-07-31 — INT8-with-attention-exclusion requantization: REJECT

Mechanism recorded at the top of `scripts/quantize_onnx.py`. The accuracy
numbers came from a mount-mangled run (see the recalibration entry) and are
not re-run because the fatal argument is GRAPH-INTRINSIC and mount-
independent. Two findings, one fatal:

1. Attempt 1 excluded 120/153 MatMuls and recall still collapsed (Person
   1.0 → 0.16, control group → 0.0). The 33 quantized nodes included the nine
   GLiNER scoring heads (span_rep / prompt_rep / projection) — the layers
   whose dot product IS the entity score. Those must stay fp32.
2. Fatal regardless of accuracy: the 1.1GB graph is ~two-thirds multilingual
   embedding table (251k vocab ≈ 740MB) that MatMul-only dynamic INT8 cannot
   touch. Measured ceiling: 1103 → 913MB (~190MB), far under the ≥0.8GB
   adoption threshold. The memory prize requires a smaller-vocab model or
   QAT — i.e. the model-swap track, not requantization of this graph.

This upgrades BFSF-269 from "INT8 is bad" to a mechanism with numbers.

## 2026-07-31 — fastino/gliner2-privacy-filter-PII-multi: REJECT as arm, keep as reference

Route B (needs the separate `gliner2` package — verified the `gliner` package
finds no config in the repo snapshot). Measured through the candidate shim
(`tools/candidate_shim/`) behind the real `/pii` contract. Evidence:
`eval/metrics.fastino.dev.{raw,fused}.json`, `eval/calibration.fastino.json`
(all collected HOST-side, so unaffected by the mount incident below; the
`?fuse=regex` numbers used the shim image's baked regex tier — an older
registry of the arbitration — and the shim's floors mount never attached, so
read the fused row as a lower bound, not a precise fusion).

| | raw fastino | fused (regex+fastino) | shipped baseline (regex+E3-JSI) |
|---|---|---|---|
| micro P / R / F1 | 0.703 / 0.755 / 0.728 | 0.961 / 0.873 / 0.915 | 0.944 / 0.977 / 0.960 |
| throughput | 187 chars/s | 411 chars/s | 739 chars/s |

Two hard floors breached, exactly as the coverage analysis predicted:

* **Control group → 0.0.** The model has no Organization / MedicalCondition /
  Medication / HealthInsurance / URL types (calibration: "93 gold spans but
  ZERO candidates" across six categories). As a replacement it deletes the
  frozen control group — auto-REJECT under decision rule 1.
* **Throughput 0.25× current** (torch fp32, 3 cores) against the ≥0.67× floor
  — synchronous use is unaffordable, and a THIRD arm would be additive
  latency on the chat path.

Also decisive: the A2/A3/A4 release already captured most of what fastino was
recruited for — the shipped baseline now measures Phone R 1.000, IBAN R 1.000
(incl. typos), NL-region R 0.991, so the marginal aggregate over the current
baseline (~+0.35 summed recall, mostly IPAddress and BankAccountNumber) is
under both the +0.60 adoption bar and the +8pp Route-B dependency bar.

**Worth keeping (the reference part):** on the categories it does cover,
fastino is markedly more precise than the current model — Person P 0.95 vs
0.79, Phone P 0.97 vs 0.91 in the fused runs. If Person-precision FPs ever
become the top complaint, the measured shape of a solution is an ASYNC or
selective second-opinion pass, not a synchronous arm. The shim + label map
stay in-tree so that experiment costs an afternoon, not a rebuild.

**Held-out was not burned**: adoption failed on dev + hard floors, so the
one-shot held-out run remains available for a future candidate.

## 2026-07-31 — threshold recalibration: ATTEMPT INVALIDATED, floors unchanged, and a measurement-infrastructure lesson

A full calibrate → apply-wholesale → gate → revert cycle was executed — and
then found to be built on sand: every container in that cycle had been
launched through Git Bash, whose MSYS path mangling silently rewrote the
CONTAINER side of each `-v` mount (`/app/eval` → `C:\Program Files\Git\app\
eval`). The volumes never mounted; the containers measured the image's BAKED
code and corpus, not the working tree. Both the calibration proposals and the
"hybrid gate rejection" of them were artifacts of that. Verified afterwards
by `mount | grep` inside a probe container; the floors block ships unchanged.

What genuinely survives from the cycle:

* **The Person-FP insight is real and mount-independent**: the hybrid Person
  false positives are REGEX-sourced (Dutch titled-person spans at 0.95), so
  no model floor can remove them — any future calibration hoping to fix
  Person precision must look at `_DUTCH_TITLED_PERSON_RE`, not at floors.
* **`calibrate.py` fits the model-only tier by design** (its own docstring);
  a calibration valid for the shipped HYBRID configuration needs a
  hybrid-mode collection. That was true before the mount bug and stays true.
* **The rule**: no threshold change ships on a model-only curve, and no
  measurement ships without verifying its mounts (probe file, or
  `mount | grep` — a silently-unmounted volume produces plausible numbers
  about the wrong code).

Operationally: measurement containers on this Windows box are launched from
PowerShell (no path conversion) or with `MSYS_NO_PATHCONV=1`. The same bug
invalidated the first gliner-0.2.28 equivalence run and the INT8 accuracy
numbers (the INT8 REJECT stands regardless — the ~190MB quantization ceiling
is intrinsic to the graph, whose bytes are two-thirds embedding table). The
fastino verdict is unaffected: its raw metrics and throughput were measured
host-side, and both hard floors (missing categories, 0.25× throughput) are
mount-independent.

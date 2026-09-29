# Classifier decisions: measured, never taken from a benchmark

Every verdict below comes from this directory's own harness, run on the
synthetic corpus in `corpus/`. No external benchmark number appears in any
decision. The evidence files are in `results/`.

## 2026-09-26: owner decision on the verdict below

The owner accepted the recommendation, as an amendment to rule 5 made after the
measurement and recorded as such:

- **Adopted:** `knowledgator/gliclass-multilang-mini` at revision
  `0bd888b6c3ef9fca5f0a9d407bddfbbc7623486b`, joint label scoring.
- **Memory:** the service scores at most **4 texts per forward pass**
  (`_BATCH_SIZE = 4`, measured peak 2,212 MB), the container limit is
  **3 GB** (`CLASSIFY_MEM=3g`) and it gets **3 CPUs** (`CLASSIFY_CPUS=3`),
  the setup every latency below was measured on.
- **Thresholds, as the rule produced them:** default **0.75**, "loose"
  **0.15**, no separate "strict" (it coincided with the default). The
  alternative default of 0.6 (better with Dutch topic words) was offered and
  not taken.
- **Text:** 512 tokens of text, the first 384 and the last 128, with the label
  prompt on top (`max_length` 1024), which is how the thresholds were measured.
  The character pre-cut on both sides (server and service) keeps the end too.

## 2026-09-26: zero-shot "is about" classifier, verdict

**By the rule as written: NO-GO.** No candidate passes rules 2 to 5.
`gliclass-multilang-mini` fails exactly one of them, rule 5 (memory), by
136 MB. It fails only because the rule's memory figure includes a batch of
8 texts × 512 tokens.

**Recommendation for the owner: ADOPT `knowledgator/gliclass-multilang-mini`,
pinned at revision `0bd888b6c3ef9fca5f0a9d407bddfbbc7623486b`, with the
service's batch capped at 4 texts per forward pass.** At that cap its peak RSS
is 2,212 MB, and it passes all five rules. This is written as a recommendation
and not as the verdict on purpose. It changes how rule 5 is measured *after* the
measurement, and that is the owner's call, not the harness's.

### The numbers (dev unless marked, 3 CPUs, fp32, CPU torch 2.14.0)

| | gliclass-mini | GLiNER2.5-multi-Decide | bge-m3-zeroshot (NLI) | gliclass-edge |
|---|---|---|---|---|
| dev macro-F1 at best t | **0.856** (t=0.75) | **0.877** (t=0.30) | 0.744 (t=0.30) | 0.586 (t=0.25) |
| dev macro-F1 at 0.5 | 0.849 | 0.799 | 0.707 | 0.569 |
| Dutch / English (at best t) | 0.833 / 0.873 | 0.865 / 0.899 | 0.711 / 0.739 | **0.543** / 0.618 |
| held-out macro-F1 at the dev t | **0.877** | not run | not run | not run |
| top-1, single-label items | 0.948 | 0.961 | 0.857 | 0.610 |
| p50 / p95, 512 tok, batch 1 | 0.69 / 0.70 s | 0.76 / 0.86 s | 17.1 / 18.0 s | 0.24 / 0.26 s |
| texts/s, 512 tok, batch 8 | 1.63 | 1.42 | 0.10 | 4.14 |
| peak RSS (batch 8 × 512) | **2,636 MB** | **3,330 MB** | **3,560 MB** | 1,376 MB |
| load time (from local cache) | 5.0 s | 6.0 s | 3.7 s | 4.3 s |
| rules failed | 5 (by 136 MB) | 5 | 3, 4, 5 | 2 |

Held-out was spent once, on the mini model only. It is the only candidate
that clears the quality and latency rules and fails the memory rule by a margin
that configuration can close. GLiNER2.5 is 2,855 MB after load alone, so no
batch size brings it under 2.5 GB. It was scored at the threshold chosen on dev
(0.75). Held-out came out *higher* than dev (0.877 against 0.856), so there is
no sign of a threshold fitted to the dev split.

Rule by rule, for the mini model:

1. 0.856 is within 0.03 of the best (GLiNER2.5, 0.877): a gap of 0.021. **Pass.**
2. Dutch 0.833 ≥ 0.60. **Pass.**
3. p50 0.69 s ≤ 1.0, p95 0.70 s ≤ 1.5. **Pass.**
4. 1.63 texts/s ≥ 1.0 at batch 8. At batch 1 it is 1.45 texts/s. **Pass.**
5. 2,636 MB > 2,500. **Fail.** Peak RSS by batch size at 512 tokens, each in a
   fresh process (`results/gliclass.memory.json`, measured *after* this result,
   to explain it):

   | batch | 1 | 2 | 4 | 8 |
   |---|---|---|---|---|
   | peak RSS | 1,990 MB | 1,999 MB | 2,212 MB | 2,668 MB |

   At batch 1 and 2 the peak is the load itself: the checkpoint is stored in
   bf16 and is converted to fp32 while it loads (2,007 MB high-water, against
   1,731 MB resident afterwards). From batch 4 on, the activations of DeBERTa's
   disentangled attention take over. Batching buys little on 3 CPUs: 1.45 texts/s
   at batch 1 against 1.63 at batch 8, the same shape the guard found in 2026-07.

The fallback in the rule cannot rescue the verdict. GLiNER2.5 also fails
rule 5, the edge model fails rule 2 (Dutch 0.543), and NLI fails rules 3, 4 and 5 (17 s per text at 512 tokens).

### Settings to ship with the mini model

- **`default_threshold`: 0.75.** That is the dev best, as the rule prescribes.
  Held-out at 0.75: macro-F1 0.877, precision 0.96, recall 0.85, and **no**
  item without a label went down any output.
- **`loose`: 0.15** (the best macro-F2). Held-out: recall 0.94, but 58% of the
  items without a label go down some output.
- **`strict`: 0.75.** The best macro-F0.5 coincides with the default on this
  corpus, so a separate strict preset buys nothing measurable. Offer "default"
  and "loose" only.
- **Worth the owner's look: a default of 0.6.** The mini model's curve is a
  plateau: dev macro-F1 0.846 to 0.856 anywhere from 0.45 to 0.75. With
  **Dutch** labels the plateau sits lower (dev, whole inbox: 0.885 at 0.6,
  0.852 at 0.75). A default of 0.6 costs 0.007 with English labels and gains
  0.033 with Dutch ones. The rule fixes 0.75, and this note does not override it.
- **The trade the threshold makes: secondary labels.** The mini model ranks
  well: on 20 of 25 dev items with two gold labels, both are its top two. But
  joint scoring pushes the second label's score down. At 0.75 an item misses
  one of its gold labels on 17 of 25 dev multi-label items (8 of 16 held-out);
  at 0.5 on 15 of 25 (4 of 16 held-out). An item that should go down two
  outputs will often go down only one. Say so in the UI help text.

### Joint vs independent label scoring: **joint**

- Scoring each label alone (the service's `label_mode="independent"`) is
  **worse and 5.5× slower** on the mini model: macro-F1 0.786 at its own best
  threshold (0.05!) against 0.856, only 0.582 at 0.75, and 1.86 s/item against
  0.34. The model was trained to score its labels together, and its scores
  collapse when it sees one label at a time. GLiNER2.5 shows the same (0.656
  against 0.877). If independent mode stays in the service, it needs its own
  threshold. Joint is the default to ship.
- The labels influence each other, but only a little (label-set sensitivity).
  Adding two distractor labels moves the gold scores by 0.027 on average
  (median 0.005, max 0.285). 11 of 762 routing decisions flip at 0.75, and
  macro-F1 goes from 0.856 to 0.846. So **adding an output to a Condition node
  can re-route items on the node's other outputs.** This is rare, but it should
  be in the UI help. The NLI model measures exactly 0 here, because its labels
  are independent by construction.

### Label phrasing: articled, and in the language of the author

- Articled labels beat bare ones: "a complaint" 0.856 against "complaint"
  0.821. The placeholder should show a noun phrase with its article.
- Dutch labels on Dutch items: **0.881** against 0.833 with English labels
  (+0.048, at 0.75). Dutch labels on English items: 0.786 against 0.873
  (−0.087). On the whole mixed inbox it is a wash at 0.75 (0.852 against
  0.856), and Dutch labels win below 0.7 (0.885 against 0.849 at 0.6).
  **Placeholder: in the author's UI language** ("een klacht" / "a complaint").
  Matching the language the items arrive in is what counts, and a Dutch
  author's inbox is mostly Dutch.
- The weakest class is "spam or marketing" (email F1 0.33 at 0.75). Long
  marketing mails score about 0 on *every* label. This was not measured, but
  it points at the "X or Y" wording: suggest one concept per label in the help
  text.

### Per-step text cap: 512 tokens, head 384 + tail 128

- Feeding the full text of a long email (up to 863 tokens) *hurts*. On the 9
  long dev emails, micro-F1 at 0.75 falls from 0.78 (first 512 tokens) to 0.53.
  The gold scores drop and the best wrong-label scores double (0.04 → 0.11).
- Head+tail (384 + 128) ties head-only on F1 (0.78). It recovers the one email
  whose cancellation sits only at the end (d-em-18: 0.003 → 0.86), and its
  mean gold score is higher (0.65 against 0.61). GLiNER2.5 gains more from
  head+tail (0.80 → 0.90). Prefer head+tail.
- 512 tokens is about **1,900 characters of Dutch and 2,000 of English**
  (3.7 and 3.9 characters per mDeBERTa token on this corpus). The service's
  `max_chars=4000` is a harmless pre-cut; `max_tokens=512` is the cap that
  matters.

### Memory limit: **3 GB at batch ≤ 4** (3.5 GB if the batch stays at 8)

This is measured peak RSS + 30%, rounded up to the next 0.5 GB:
2,212 × 1.3 = 2,876 MB at batch 4, and 2,636 × 1.3 = 3,427 MB at batch 8.

**The service as currently drafted does not fit.** `docker-compose.yml` sets
`mem_limit: 2560m`, and `classifier.py` uses `_BATCH_SIZE = 8`. A full batch of
long texts peaked at 2,636 MB here, so that container would be OOM-killed. Cap
the batch at 4 and raise the limit to 3g. The compose file also defaults to
`cpus: 2`, while every latency here was measured at 3. At 2 CPUs, expect
roughly 1.5× the latency: about 1.0 s p50 at 512 tokens. That is still inside
rule 3, but it was not measured.

### File names: a good use case

File names are the mini model's strongest kind: dev macro-F1 0.935 (held-out
0.883), with **no** false positive on a file name without a label in either
split. They are 5 to 18 tokens long, so a call costs less than the 64-token
row (0.16 s). The misses are the second label of compound names
("Scan_getekende_offerte_en_opdrachtbevestiging.pdf" was routed to contract
only).

### Candidates not adopted

- **GLiNER2.5-multi-Decide.** It is the most accurate (0.877, and the best
  Dutch score at 0.865). It fails rule 5 at load alone (2,855 MB high-water;
  3,330 MB after batch 8). Its threshold curve is sharp: 0.877 at 0.3 but 0.799
  at 0.5 and 0.592 at 0.75, so one global default would be fragile. It also
  needs transformers<5 plus a protobuf workaround to load, and the checkpoint
  was two days old when it was measured. Keep it as the reference if accuracy
  ever outranks memory.
- **bge-m3-zeroshot-v2.0-c (NLI).** 0.744, Dutch 0.711. Its cost grows with
  the number of labels (one XLM-R-large pass per label). At 512 tokens and 6 labels it takes 17 s per text on 3 CPUs (0.10 texts/s at batch 8) and peaks at 3,560 MB: out on CPU by a factor of 17 on latency alone.
- **gliclass-multilang-edge** is the owner's CPU fallback. It is fast and small
  (0.24 s p50, 1,376 MB), but at 0.586 (Dutch 0.543) it is not a usable
  classifier on this task. **No smaller model fits.** If the mini model's memory
  is the blocker, the answer is the batch cap, not the edge model.

### What surprised us, and what the harness had to work around

- `gliclass`: `pipeline(texts, labels, threshold=0)` returns, per text, a list
  of `{label, score}` with a sigmoid score for every label. The weights are
  stored in bf16, and transformers 5 loads the stored dtype, so `dtype=float32`
  has to be passed. The service already does.
- `gliner2` 2.0.0: the plain install has no torch (it is an API client), and
  local inference needs `gliner2[local]`, which pins transformers<5. But the
  GLiNER2.5 checkpoint was saved by transformers 5, and its tokenizer config
  breaks 4.57. gliner2's own fallback only fires when `protobuf` is installed.
  The model loads only through `AutoExtractor` (`GLiNER2.from_pretrained` is
  span-only), and `from_pretrained` does not pass `revision` to the tokenizer,
  so the adapter loads from a pinned snapshot path. The multi-label task with
  `cls_threshold: 0.0` and `include_confidence=True` returns
  `{task: [{label, confidence}, ...]}`.
- The bge-m3-zeroshot tokenizer caps at 512 tokens (`model_max_length`), not at
  bge-m3's 8,192.
- Probes added after the first dev runs, all informational and not gates:
  Dutch labels on *every* item (the brief asked for Dutch items only), the
  independent-label probe, and whole threshold curves per probe. All four dev
  files were re-run on the final code. The gliclass and GLiNER2.5 headline
  numbers were bit-identical across re-runs. The NLI dev file predates the
  independent probe, which does not apply to it. NLI's eval ran on 8 CPUs to
  save wall time; scores do not depend on the thread count, and its bench ran
  on 3.
- An external Docker daemon restart (16:14) killed two runs mid-way. Both were
  re-run from the start.

## 2026-09-26: zero-shot "is about" classifier, adoption rule (written before any run)

This rule was committed to paper before any model was loaded, so the
measurements cannot bend it.

### What is being chosen

The model behind the new "is about" operator in the Automations Condition
node. An author writes `Body` → is about → "a complaint". At run time, one item
(an email, a file name, a file's text or a form answer, in Dutch or English) is
scored against every label used in that node. The item goes down every output
whose score is at or above the threshold, and an item that matches no label goes
to "otherwise".

Candidates:

1. `knowledgator/gliclass-multilang-mini` (Apache-2.0, mDeBERTa-v3-base), the
   preferred default
2. `fastino/GLiNER2.5-multi-Decide` (Apache-2.0, mDeBERTa-v3-base)
3. `MoritzLaurer/bge-m3-zeroshot-v2.0-c` (MIT), NLI entailment, one pass per label
4. `knowledgator/gliclass-multilang-edge` (Apache-2.0, mmBERT-small, ~140M),
   the CPU fallback in case the mini model is too slow

**The classifier runs on CPU. There is no GPU anywhere** (owner rule). Every
adapter uses `device='cpu'` and the CPU build of torch. A model that is usable
only with a GPU is out, however well it scores.

### Definitions, fixed in advance

- **Headline configuration.** English labels, articled form ("a complaint").
  The item's text is cut to its first 512 tokens of that model's tokenizer.
  All labels of the item's kind are scored in one call. That is joint scoring,
  and it is how production will call the model. For the NLI model the
  hypothesis template is `"This text is about {}."` for every item.
- **Class.** A class is a (kind, label) pair. Each kind has its own label set
  (`corpus/labelsets.json`).
- **Macro-F1.** The unweighted mean of per-class F1, over the classes that have
  at least one gold positive in the split.
- **Micro-F1.** Pooled TP/FP/FN over every (item, label) decision.
- **Best threshold.** The value in the sweep 0.05 to 0.95 (step 0.05) with the
  highest dev macro-F1. A tie goes to the value closest to 0.5.
- **Dutch macro-F1.** Macro-F1 over the Dutch items only, at the model's
  overall best threshold, not at a Dutch-specific one.
- **Latency and throughput.** `bench.py` with 6 labels, with
  `torch.set_num_threads(3)`, in a container started with `--cpus 3
  --memory 4g`. Latency is p50/p95 per call at batch 1. Throughput is texts per
  second at batch 8. Both are measured at about 64, 256 and 512 tokens, and the
  gates read the 512-token row.
- **Peak RSS.** `VmHWM` from `/proc/self/status`, the larger of the value after
  load and the value after a batch of 8 at 512 tokens.

### The rule

Adopt `gliclass-multilang-mini` as the default if **all** of these hold:

1. Its dev macro-F1 at its best threshold is within **0.03** of the best
   candidate's dev macro-F1 at that candidate's own best threshold.
2. Its Dutch dev macro-F1 is at least **0.60**.
3. **CPU latency** (3 CPUs, 6 labels, about 512 tokens, batch 1): p50 at most
   **1.0 s** and p95 at most **1.5 s**.
4. **CPU throughput** (3 CPUs, 6 labels, about 512 tokens, batch 8): at least
   **1.0 text/s**.
5. **Memory**: peak RSS at most **2.5 GB**.

Rules 3 to 5 are hard CPU gates. They apply to every candidate, and no
accuracy margin can buy a candidate past them.

If any rule fails for the mini model, adopt the candidate with the highest dev
macro-F1 among those that pass rules 2 to 5. If no candidate passes rules 2 to
5, the verdict is NO-GO, and the operator does not ship on a local model.

*Amended 2026-09-26, before any corpus measurement.* Only API smoke tests
(does it load, and what does it return) had run at that point. The owner then
required CPU-only operation. Rules 3 to 5 were widened from "p95 and RSS" to
the full set of CPU numbers, and the edge model was added as the fallback to
measure if the mini model is too slow.

A candidate that fails to install or load counts as absent. If it was the best
scorer, it cannot make rule 1 fail for another candidate.

### The held-out split

The held-out split is run **once**, and only for the finalist or finalists,
at the threshold chosen on dev. It confirms the choice; it does not re-tune it.
If held-out macro-F1 is more than 0.10 below dev, that gets written down as a
finding against the threshold. The threshold is not re-fitted on held-out.

### Presets, fixed in advance

- `default_threshold` is the dev best threshold of the adopted model.
- `loose` is the threshold that maximises dev macro-F2 (it leans towards recall).
- `strict` is the threshold that maximises dev macro-F0.5 (it leans towards
  precision).

### Recorded for information, not gates

- **Label-set sensitivity.** The mean absolute change in the gold labels'
  scores when two distractor labels are added to the kind's label set. Near 0
  means the labels are scored independently. A large value means that adding
  an output to a Condition node moves the scores of the other outputs.
- **Label phrasing.** "complaint" vs "a complaint". Dutch labels vs English
  labels on Dutch items. For the NLI model, Dutch labels go with the template
  `"Deze tekst gaat over {}."`
- **Truncation.** On the long emails: the first 512 tokens (head) vs the first
  384 plus the last 128 (head+tail) vs the full text.
- **Breakdowns.** By language and by kind, top-1 accuracy on single-label
  items, and the false-positive rate on items with no gold label.

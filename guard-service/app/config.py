"""
Guard Service configuration — loaded from environment variables.
"""

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """Guard service settings."""

    app_name: str = "guard-service"
    # Identity of the IMAGE, baked at build time from the git sha.
    #
    # Load-bearing for callers that cache detection results with no expiry:
    # _engine_fingerprint() covers the model, the ONNX graph, the label grouping
    # and the tier, but NOT the Python that post-processes a detection. A
    # detection-quality release (suppression gate, regex patterns, validators)
    # changes what comes out while every one of those inputs stays identical, so
    # without a build id such a release would never reach content that was
    # already scanned. Unset in dev = "dev", which simply never invalidates.
    guard_build_id: str = "dev"
    debug: bool = False
    host: str = "0.0.0.0"
    port: int = 8100

    redis_url: str = "redis://localhost:6379/1"

    # CPU PII detection (GLiNER, Apache 2.0)
    # Fine-tune of urchade/gliner_multi_pii-v1 with Dutch + healthcare/finance/legal
    # domain coverage added. Set GUARD_PII_ENABLED=false to skip loading.
    pii_model: str = "E3-JSI/gliner-multi-pii-domains-v1"
    pii_enabled: bool = True

    # ONNX model directory baked into the image at build time.
    #
    # BFSF-269: we ship a NON-quantized (fp32) ONNX graph. The INT8-quantized
    # graph was ~3-6x faster but destroyed person-name recall (Person
    # confidence collapsed from ~0.88-0.98 to ~0.14-0.22, so bare names fell
    # under the floor and only regex-titled names survived). fp32 ONNX keeps
    # full recall (~0.84-0.96, measured) AND ONNX-runtime CPU speed (~30ms vs
    # ~1000ms for fp32 PyTorch) — best CPU option. Costs ~2.5GB RSS (vs ~1.3GB
    # for INT8). Set GUARD_PII_USE_ONNX=false to force the fp32 PyTorch weights
    # (same recall, much slower) if the ONNX graph is ever unavailable.
    pii_use_onnx: bool = True
    pii_onnx_dir: str = "/opt/gliner-onnx"
    pii_onnx_file: str = "model.onnx"

    # ── Resource guards ────────────────────────────────────────────────
    # Hard bounds so a big-document scan can never monopolise the pod or
    # starve other users (the guard is also cgroup-capped at the k8s level,
    # but these keep it fair WITHIN its budget).
    #
    # Max concurrent /pii requests admitted per pod. GLiNER uses all allocated
    # cores per call, so >1 concurrent scan oversubscribes; a small pool
    # lets a couple of short scans overlap while big ones queue rather than
    # thrash. Extra requests wait on the semaphore (fair FIFO-ish).
    #
    # This is an ADMISSION knob, not a safety one — do not read it as the thing
    # that keeps the model single-threaded. It never did: each admitted request
    # runs detect() in its own asyncio.to_thread worker against the singleton,
    # so at 2 two threads shared one Rust `tokenizers` instance and raised
    # "Already borrowed" under load. PiiService._inference_lock is what
    # serialises the model now (per call, so a long document does not block a
    # short one for its whole length).
    pii_max_concurrency: int = 2
    # ONNX Runtime intra-op thread count. 0 = derive from the cgroup CPU quota
    # (app/cpu.py available_cpus()), which is the historical behaviour.
    #
    # Worth knowing WHY this knob exists: available_cpus() reads the cgroup
    # QUOTA, i.e. limits.cpu — never cpu.shares/cpu.weight, which is where
    # requests.cpu lives. So when a deployment requests less than it limits,
    # the service sizes its thread pool for CPU it is not guaranteed, and under
    # node pressure those threads thrash a smaller share. If you cannot raise
    # requests.cpu to match limits.cpu, set this to the REQUEST instead.
    #
    # Also note pii_max_concurrency multiplies it: 2 concurrent scans x N
    # intra-op threads is the real thread count competing for the quota.
    pii_ort_intra_op_threads: int = 0
    # How the model is protected against concurrent use.
    #
    #   "tokenizer" (default) — only tokenisation is serialised, via a
    #       per-thread tokenizer instance. ORT's InferenceSession.Run() is
    #       documented thread-safe on the CPU EP and the gliner ORT wrapper
    #       holds no mutable state, so forward passes run concurrently.
    #   "global" — the historical pod-wide lock around every model touch.
    #       Kill switch: a restart, no rebuild.
    #
    # The old lock covered Run() only because the REAL culprit sat next to it:
    # transformers._set_truncation_and_padding mutates the Rust tokenizer on
    # every call that passes padding=/truncation= (gliner's processor passes
    # both), so two threads inside it raise "Already borrowed". Per-thread
    # tokenizers remove the sharing instead of serialising the whole model.
    pii_inference_lock: str = "tokenizer"
    # Forward passes issued concurrently WITHIN one scan. A scan is a queue of
    # independent (chunk x label-group) passes, and it was walked one at a time.
    #
    # 0 = derive from the CPU quota. Measured 2026-07-31 on an 8-core quota with
    # intra_op=8, one ~366-token chunk: 395 ms/pass at 1 worker -> 294 ms/pass at
    # 8 (1.35x). Note intra_op is deliberately NOT lowered to compensate:
    # concurrent Run() calls SHARE one ORT intra-op pool rather than each
    # spawning their own, so a single-pass scan keeps its 395 ms and nothing
    # regresses. Lowering intra_op to 1 and running 8 workers measured slightly
    # faster still (253 ms/pass) but makes a one-pass scan ~3x slower — a bad
    # trade for short chat messages, which are most of the traffic.
    pii_predict_workers: int = 0
    # Scan budget: text up to this length is scanned in full. Beyond it (up to
    # pii_hard_max_chars) we scan a bounded PREFIX and return a PARTIAL result
    # (degraded + processed_chars/total_chars) rather than dropping everything —
    # so a big doc still gets the redactions we computed while the unscanned
    # tail is failed closed by a coverage-aware caller. ~1M chars ≈ 200 pages.
    pii_max_chars: int = 1_000_000
    # Absolute ceiling: a single request larger than this is refused outright
    # (degraded=input_too_large) — bounds just holding the string in memory.
    pii_hard_max_chars: int = 4_000_000
    # Per-request WORK budget, as opposed to the memory budget above.
    #
    # pii_max_chars alone was not a budget the caller could survive: the Node
    # client gives up at 90s (piiDetection.js), and a full scan of ~1M chars is
    # multiple hours. Production hit the gap — 52,990 chars took 278s, so the
    # client timed out, reported the guard unreachable, and a fail-closed org
    # blocked the message. Nothing had refused the work; it was simply too much
    # of it. Bounding the prefix turns that into a partial result the caller can
    # reason about (processed_chars/total_chars) instead of a timeout it cannot.
    #
    # 0 = derive from the detection tier, which is what decides the per-char
    # cost: `on` asks GLiNER for ~4 label groups, `shadow`/`off` for all 7.
    # Measured on prod under `shadow`: ~4.5ms/char. Set explicitly to override.
    #
    # This is a BACKSTOP. The server windows large text before sending, so in
    # the normal chat path no single request approaches this. It is here for
    # callers that do not window: older self-host server images, direct API
    # users, and batch tooling.
    pii_scan_budget_chars: int = 0

    # Run a representative inference at startup so the first real request
    # doesn't pay ONNX graph-finalisation + ORT arena growth (cold-start).
    pii_warm_inference: bool = True

    # ── Detection tier (GLiNER-only cutover) ───────────────────────────
    # The regex tier is being retired so GLiNER performs all detection. This
    # flag makes that a reversible, per-environment rollout on ONE image
    # rather than a one-way door:
    #
    #   on      both tiers, regex wins overlap resolution — today's behaviour.
    #   shadow  both tiers run and the UNION is returned (so user-visible
    #           behaviour is identical to `on`), and a per-tier CATEGORY COUNT
    #           is logged: how many spans regex found, the model found, and
    #           both found. Zero blast radius, and it doubles as the production
    #           load test for the wider label-group configuration.
    #   off     GLiNER only. The regex tier does not run.
    #
    # NOTE on `shadow`, corrected: this used to promise a per-category *span
    # diff* ("which spans only regex found"). That was never built, and it is
    # not going to be — a span-level diff shows where the tiers DISAGREE but
    # cannot show which was RIGHT, because production traffic has no gold
    # labels. Adjudicating a disagreement would mean a human reading real
    # customer text, which is the one thing this product must not do. Gold
    # labels live in eval/corpus/; that is what the corpus is for.
    #
    # What `shadow` gives that the corpus cannot: latency and degraded-rate
    # under real load at the full label-group count, plus an aggregate volume
    # signal (would `off` have produced FEWER detections on this org's
    # traffic?). Silent under-detection is the real rollout risk, and a count
    # answers it. Run it in STAGING — in production it is the most expensive
    # configuration available, since it pays for both tiers at once.
    #
    # Rollback from `off` is this env var plus a restart — no rebuild, no
    # coordination with the Node side. Self-host compose keeps defaulting to
    # `on` for a full release so upgrading users get identical behaviour.
    pii_regex_tier: str = "on"

    # ── Detection regions ──────────────────────────────────────────────
    # Which countries' identifier patterns the regex tier applies, as a
    # comma-separated list of ISO 3166-1 alpha-2 codes. `*` means all shipped
    # regions, which is the default: a tenant that has not said where its people
    # are is better served by broad recall than by an accidental blind spot.
    #
    # This is not only a precision knob, and that is the important part. The
    # regex tier suppresses GLiNER for the categories it claims
    # (REGEX_COMPLETE_CATEGORIES), and before regions existed those claims were
    # global while the patterns were Dutch. A German tenant therefore lost the
    # model for national IDs, tax IDs and licence plates and got a Dutch pattern
    # that could not match theirs — measured at up to 63.7pp recall on national
    # ID. Completeness is now computed per active region, so narrowing regions
    # narrows suppression with it.
    #
    # Narrow it per-organisation (piiRegions on the privacy shield) when a tenant
    # is genuinely single-country and cross-country shape collisions matter more
    # than coverage.
    pii_regions: str = "*"

    # Treat a PARTIAL label-group failure as degraded. With seven groups over
    # disjoint category sets, one dead group means a whole slice of categories
    # is missing while the response otherwise looks clean. Set false to accept
    # the incomplete result instead (fewer fail-closed blocks on transient ORT
    # errors, at the cost of silent under-detection).
    pii_degrade_on_partial_group_failure: bool = True

    # ── AI-disclosure classifier (optional, OFF in the default image) ──
    # "Does this text tell its reader that AI was involved" — an embedding
    # classifier over a fixed anchor bank (app/services/disclosure/), which
    # assists the Art. 50 keyword rule on the Node side. Deterministic; no
    # generation anywhere in it.
    #
    # There is NO encoder in the default image and that is deliberate: this
    # sidecar exists to run one CPU model, and a multilingual sentence encoder
    # is another ~470MB in an image every self-hosting customer pulls, for one
    # compliance check. Bake it with the GUARD_DISCLOSURE_MODEL build arg
    # (scripts/export_disclosure_encoder.py) when you want it. Absent, /pii is
    # untouched and /disclosure answers "no opinion" — never "no disclosure".
    disclosure_enabled: bool = True
    disclosure_model: str = (
        "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
    )
    disclosure_model_dir: str = "/opt/disclosure-encoder"
    # Tokens per segment. Segments are sentence-sized by construction
    # (similarity.MAX_SEGMENT_CHARS), so this only bounds a pathological one.
    disclosure_max_tokens: int = 128
    # How near the positive bank a segment must come before "this looks like a
    # disclosure" is on the table at all. Under it the answer is a confident
    # "no disclosure", which is the ordinary verdict for the ordinary prompt.
    disclosure_floor: float = 0.45
    # How far apart the two banks must be before either wins. Inside it the
    # classifier ABSTAINS (disclosed=null) rather than calling a coin toss —
    # an abstention leaves the keyword rule standing, a wrong call does not.
    disclosure_margin: float = 0.06
    # Work bound per request. Past it the request is refused rather than
    # truncated: a disclosure past the cut would come back as "no disclosure",
    # which is the one direction this classifier may not be wrong in.
    disclosure_max_chars: int = 200_000

    log_level: str = "INFO"

    model_config = {"env_prefix": "GUARD_", "env_file": ".env", "extra": "ignore"}


settings = Settings()

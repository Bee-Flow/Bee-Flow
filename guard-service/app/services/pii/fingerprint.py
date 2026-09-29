"""Identity of the configuration that produced a detection result.

Two consumers, both of which cache: this package keys its own Redis entries on
``_engine_fingerprint()``, and callers outside the guard key theirs on the
published ``engine_fingerprint_digest()``. Neither can tell a model swap, a
label-regrouping or a tier flip from the backend name alone, and serving a
stale verdict after such a change is a silent under-redaction.
"""

from __future__ import annotations

from .label_groups import _label_group_digest
from .scan_policy import _effective_regions, resolve_tier_mode


def _gliner_version() -> str:
    """The installed gliner library, or "none" where it is absent (unit tests).

    A gliner bump re-exports the ONNX graph at build time under the SAME
    filename, so pii_onnx_file alone cannot tell the two graphs apart.
    """
    from importlib.metadata import PackageNotFoundError, version

    try:
        return version("gliner")
    except PackageNotFoundError:
        return "none"


def _engine_fingerprint() -> str:
    """Identity of the configuration that produces a detection result.

    The cache key used to hash only (text, threshold, categories) — everything
    about HOW the text was scanned was missing. That is not theoretical:
    GUARD_PII_REGEX_TIER is documented (app/config.py:75-106) as a
    restart-not-rebuild rollout knob, so during a staged rollout `on` and `off`
    pods run side by side against one Redis for the 600 s TTL. An `off` pod
    serves an `on` pod's result and vice versa — precisely the configurations
    the rollout exists to compare.

    Worse for diagnosis: the cached blob carries the WRITER's `tier_mode`, so
    the per-request log line (app/routers/pii.py:98) attributes the result to a
    mode that did not produce it, destroying the one signal `tier_mode` exists
    for. The same applies to a model or ONNX-graph swap, and to the label
    grouping, which decides which categories are reachable at all.

    Memoised: every input is process-constant except the tier, which is read
    fresh because a test may patch it.
    """
    global _ENGINE_FP_STATIC
    from app.config import settings

    if _ENGINE_FP_STATIC is None:
        _ENGINE_FP_STATIC = "|".join(
            [
                str(getattr(settings, "pii_model", "")),
                str(getattr(settings, "pii_onnx_file", "")),
                "onnx" if getattr(settings, "pii_use_onnx", True) else "torch",
                f"gliner={_gliner_version()}",
                # The grouping decides which labels share a forward pass, and
                # therefore which categories are reachable and at what score.
                _label_group_digest(),
                str(getattr(settings, "pii_max_chars", "")),
            ]
        )
    return f"{_ENGINE_FP_STATIC}|tier={resolve_tier_mode()}"


_ENGINE_FP_STATIC: str | None = None


def reset_engine_fingerprint() -> None:
    """Forget the memo so the next call recomputes it.

    The memo is over process-constant inputs, so nothing in the service ever
    needs this. A test that patches one of those inputs does: without it the
    fingerprint would keep describing the configuration that happened to be
    loaded first, which is the one thing a fingerprint may not do.

    This exists so that clearing the memo is a CALL and not an assignment.
    Rebinding `pii._ENGINE_FP_STATIC` from outside used to require the package
    to mirror writes onto this module — see the history in __init__.py — and a
    seam nobody can see is how that mirroring became load-bearing.
    """
    global _ENGINE_FP_STATIC
    _ENGINE_FP_STATIC = None


def engine_fingerprint_digest(enabled_regions=None, custom_digest=None) -> str:
    """Short, opaque digest of _engine_fingerprint(), safe to publish.

    Callers OUTSIDE the guard need to know "did the thing that produces
    detections change?" so they can key their own caches on it. Without this
    they cannot: /health only reported `backend` ("onnx-fp32"), which is
    identical across a model swap, a label-grouping change and a tier flip.

    A cache with no expiry — which is what a content-addressed scan cache on
    the Node side is — would otherwise serve verdicts from the previous model
    forever after a guard upgrade. That is a silent under-redaction, so this is
    load-bearing rather than informational.

    Digested rather than returned raw: the fingerprint embeds model paths and
    config values, and consumers only ever need equality.

    ``custom_digest`` (custom_labels.custom_label_digest) identifies a
    request's custom labels. Absent, the digest is exactly what it was before
    custom labels existed; present, it differs, because those labels decided
    part of the answer.
    """
    import hashlib as _h
    from app.config import settings

    parts = [
        _engine_fingerprint(),
        # The image itself — see settings.guard_build_id for why the model
        # fingerprint alone is not enough.
        str(getattr(settings, "guard_build_id", "dev")),
        # Regions decide which categories the regex tier suppresses, so two
        # pods with the same model can legitimately return different entities.
        ",".join(sorted(_effective_regions(enabled_regions) or [])),
    ]
    if custom_digest:
        parts.append(f"custom={custom_digest}")
    material = "|".join(parts)
    return _h.sha256(material.encode("utf-8")).hexdigest()[:16]

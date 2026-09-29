"""MoritzLaurer/bge-m3-zeroshot-v2.0-c through transformers' zero-shot pipeline.

NLI entailment: each (text, "This text is about <label>.") pair is its own
forward pass, and with multi_label=True each label's score is its own
entailment-vs-not-entailment softmax. The labels are therefore scored
independently, and the cost grows linearly with the number of labels.

The tokenizer's model_max_length is 512, and the pipeline truncates the text
(only_first) to fit it, so "full text" for this model still means 512 tokens.
"""

from __future__ import annotations

import torch
from huggingface_hub import snapshot_download

MODEL_ID = "MoritzLaurer/bge-m3-zeroshot-v2.0-c"
REVISION = "705510dfe0f35d223a4bf6f5d2695ec5fd162341"
BATCH_SIZE = 8  # (text, hypothesis) pairs per forward pass
TEMPLATE_EN = "This text is about {}."
TEMPLATE_NL = "Deze tekst gaat over {}."
SUPPORTS_TEMPLATE = True
# One entailment pass per (text, label): no label can move another.
INDEPENDENT_BY_CONSTRUCTION = True

_state: dict = {}


def load() -> dict:
    from transformers import pipeline

    path = snapshot_download(MODEL_ID, revision=REVISION)
    pipe = pipeline(
        "zero-shot-classification", model=path, device="cpu", dtype=torch.float32
    )
    _state["pipe"] = pipe
    return {
        "model_id": MODEL_ID,
        "revision": REVISION,
        "package": "transformers",
        "dtype": str(pipe.model.dtype),
        "device": str(pipe.model.device),
        "label_scoring": "independent (one entailment pass per label)",
        "score": "entailment softmax per (text, label) pair",
        "hypothesis_template": TEMPLATE_EN,
        "max_length": pipe.tokenizer.model_max_length,
        "parameters_m": round(sum(p.numel() for p in pipe.model.parameters()) / 1e6, 1),
    }


def tokenizer():
    return _state["pipe"].tokenizer


def scores(
    texts: list[str], labels: list[str], hypothesis_template: str = TEMPLATE_EN
) -> list[dict[str, float]]:
    with torch.inference_mode():
        out = _state["pipe"](
            list(texts),
            candidate_labels=list(labels),
            hypothesis_template=hypothesis_template,
            multi_label=True,
            batch_size=BATCH_SIZE,
        )
    if isinstance(out, dict):
        out = [out]
    return [dict(zip(o["labels"], map(float, o["scores"]), strict=True)) for o in out]

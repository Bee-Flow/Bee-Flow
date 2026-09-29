"""knowledgator/gliclass-multilang-{mini,edge} through the `gliclass` package.

Uni-encoder: the labels are written into the same sequence as the text
(`<<LABEL>>a complaint<<LABEL>>an invoice<<SEP>>text`), so every label is
scored jointly with every other one. That is how production calls it: one pass
per item, all the labels of the Condition node at once.

The weights are stored in bfloat16. They are loaded as float32 on purpose: the
eval measures the CPU configuration that would ship, and bf16 matmuls on CPU
depend on the instruction set of the host.
"""

from __future__ import annotations

import torch
from huggingface_hub import snapshot_download

VARIANTS = {
    # mDeBERTa-v3-base encoder, ~284M parameters
    "mini": (
        "knowledgator/gliclass-multilang-mini",
        "0bd888b6c3ef9fca5f0a9d407bddfbbc7623486b",
    ),
    # mmBERT-small (ModernBERT) encoder, ~140M parameters: the CPU fallback
    "edge": (
        "knowledgator/gliclass-multilang-edge",
        "d16c08ef70547514081952104e6fc3d190d9ee39",
    ),
}
BATCH_SIZE = 8
# The pipeline's own default: the cap on label prompt + text, in tokens. The
# runner cuts the text first, so this only binds in the "full" truncation probe.
MAX_LENGTH = 1024

_state: dict = {}


def load(variant: str = "mini") -> dict:
    from gliclass import GLiClassModel, ZeroShotClassificationPipeline
    from transformers import AutoTokenizer

    model_id, revision = VARIANTS[variant]
    path = snapshot_download(model_id, revision=revision)
    model = GLiClassModel.from_pretrained(path, dtype=torch.float32)
    model.eval()
    tok = AutoTokenizer.from_pretrained(path)
    _state["tok"] = tok
    _state["pipe"] = ZeroShotClassificationPipeline(
        model,
        tok,
        classification_type="multi-label",
        device="cpu",
        progress_bar=False,
        max_length=MAX_LENGTH,
    )
    return {
        "model_id": model_id,
        "revision": revision,
        "package": "gliclass",
        "dtype": str(next(model.parameters()).dtype),
        "device": "cpu",
        "label_scoring": "joint (labels in the same sequence as the text)",
        "score": "sigmoid per label",
        "max_length": MAX_LENGTH,
        "parameters_m": round(sum(p.numel() for p in model.parameters()) / 1e6, 1),
    }


def tokenizer():
    return _state["tok"]


def scores(texts: list[str], labels: list[str]) -> list[dict[str, float]]:
    with torch.inference_mode():
        rows = _state["pipe"](
            list(texts), list(labels), threshold=0.0, batch_size=BATCH_SIZE
        )
    out = [{p["label"]: float(p["score"]) for p in row} for row in rows]
    for row in out:
        if set(row) != set(labels):
            raise RuntimeError(f"gliclass returned {sorted(row)} for labels {labels}")
    return out

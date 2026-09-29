"""fastino/GLiNER2.5-multi-Decide through the `gliner2` package (boundary architecture).

`AutoExtractor` is required: `GLiNER2.from_pretrained` loads span checkpoints
only. The labels go into one classification task with `multi_label` on and a
threshold of 0, so every label comes back with its confidence. The labels share
the prompt with the text, so this model also scores them jointly.

Two traps, both met while building this:

* `from_pretrained` loads the tokenizer from the repo id without the revision,
  so the pinned revision is downloaded first and loaded from its local path.
* The checkpoint's tokenizer_config.json was written by transformers 5, but
  gliner2[local] pins transformers<5. gliner2 retries on the AttributeError this
  causes, but only when protobuf is installed (see requirements-eval-gliner2.txt).
"""

from __future__ import annotations

import torch
from huggingface_hub import snapshot_download

MODEL_ID = "fastino/GLiNER2.5-multi-Decide"
REVISION = "6bc1d43d201b0691e733626389af8c57eea3ea68"
BATCH_SIZE = 8
TASK = "topic"

_state: dict = {}


def load() -> dict:
    from gliner2 import AutoExtractor
    from gliner2.models.base import load_extractor_tokenizer

    path = snapshot_download(MODEL_ID, revision=REVISION)
    model = AutoExtractor.from_pretrained(path, map_location="cpu")
    model.eval()
    _state["model"] = model
    _state["tok"] = load_extractor_tokenizer(path)
    return {
        "model_id": MODEL_ID,
        "revision": REVISION,
        "package": "gliner2",
        "dtype": str(next(model.parameters()).dtype),
        "device": str(next(model.parameters()).device),
        "label_scoring": "joint (labels in the schema prompt with the text)",
        "score": "multi_label confidence per label",
        "max_len": getattr(model.config, "max_len", None),
        "parameters_m": round(sum(p.numel() for p in model.parameters()) / 1e6, 1),
    }


def tokenizer():
    return _state["tok"]


def scores(texts: list[str], labels: list[str]) -> list[dict[str, float]]:
    tasks = {TASK: {"labels": list(labels), "multi_label": True, "cls_threshold": 0.0}}
    with torch.inference_mode():
        rows = _state["model"].batch_classify_text(
            list(texts),
            tasks,
            batch_size=BATCH_SIZE,
            threshold=0.0,
            include_confidence=True,
        )
    out = [{d["label"]: float(d["confidence"]) for d in row[TASK]} for row in rows]
    for row in out:
        if set(row) != set(labels):
            raise RuntimeError(f"gliner2 returned {sorted(row)} for labels {labels}")
    return out

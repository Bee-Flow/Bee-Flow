"""Build time only: put the classifier into the image and prove it classifies.

    CLASSIFY_MODEL=knowledgator/gliclass-multilang-mini \
    CLASSIFY_MODEL_REVISION=<sha> python scripts/bake_model.py

1. Resolves the requested revision to a commit sha and downloads exactly that
   snapshot into CLASSIFY_MODEL_DIR (default /opt/model).
2. Loads it the way the service does and classifies one sentence of our own.
   The build fails when the obvious label does not win: a checkpoint whose
   weights did not load (a key rename between library versions leaves them
   randomly initialised) still "runs", so running is not the test.
3. Writes BAKED.json beside the weights: model id, resolved revision and the
   gliclass version. /health reports that file, so the identity a caller sees
   is the identity of the bytes on disk.

Runtime never downloads anything: the image sets HF_HUB_OFFLINE=1 after this.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

MODEL = os.environ.get("CLASSIFY_MODEL", "knowledgator/gliclass-multilang-mini")
REVISION = os.environ.get("CLASSIFY_MODEL_REVISION", "main")
TARGET = Path(os.environ.get("CLASSIFY_MODEL_DIR", "/opt/model"))

SMOKE_TEXT = "NASA launched a new Mars rover to search for signs of ancient life."
SMOKE_LABELS = ["space", "sports", "cooking"]


def download() -> str:
    from huggingface_hub import HfApi, snapshot_download

    sha = HfApi().model_info(MODEL, revision=REVISION).sha
    # The images are the model card's charts; nothing loads them.
    snapshot_download(MODEL, revision=sha, local_dir=TARGET, ignore_patterns=["*.png"])
    return sha


def smoke() -> dict[str, float]:
    import torch
    from gliclass import GLiClassModel, ZeroShotClassificationPipeline
    from transformers import AutoTokenizer

    model = GLiClassModel.from_pretrained(str(TARGET), dtype=torch.float32)
    tokenizer = AutoTokenizer.from_pretrained(str(TARGET))
    pipeline = ZeroShotClassificationPipeline(
        model,
        tokenizer,
        max_length=512,
        classification_type="multi-label",
        device="cpu",
        progress_bar=False,
    )
    row = pipeline([SMOKE_TEXT], SMOKE_LABELS, threshold=0.0)[0]
    return {item["label"]: round(float(item["score"]), 4) for item in row}


def main() -> int:
    sha = download()
    scores = smoke()
    print(f"[bake] {MODEL}@{sha} smoke scores: {scores}")
    if set(scores) != set(SMOKE_LABELS) or max(scores, key=scores.get) != "space":
        print("[bake] smoke classification failed: the model did not load correctly")
        return 1

    import gliclass

    baked = {
        "model": MODEL,
        "revision": sha,
        "requested_revision": REVISION,
        "gliclass": gliclass.__version__,
        "smoke": scores,
    }
    (TARGET / "BAKED.json").write_text(json.dumps(baked, indent=2) + "\n")
    print(f"[bake] wrote {TARGET / 'BAKED.json'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

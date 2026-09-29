"""Build-time bake of the OPTIONAL AI-disclosure sentence encoder.

Not run by the default image build. The Dockerfile only calls this when
``--build-arg GUARD_DISCLOSURE_MODEL=<hf id>`` is given, because this adds
~470MB to an image every self-hosting customer pulls, for one compliance
check. Without it the guard behaves exactly as it did: /pii untouched, and
/disclosure answering "no opinion" so the Art. 50 keyword rule stands alone.

Downloads the encoder once and saves model + tokenizer into
``GUARD_DISCLOSURE_MODEL_DIR``, so the runtime needs no network — the same
reason scripts/export_onnx.py exists for the PII model, and the same
constraint: production pods are egress-blocked and a runtime Hugging Face
download is a pod that never becomes useful.

No ONNX export here, deliberately. This encoder runs a handful of short
segments per compliance sweep, not a scan per chat message, so fp32 PyTorch on
CPU is fast enough and the export step is one more thing to keep working.

    docker build --build-arg \\
        GUARD_DISCLOSURE_MODEL=sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2 \\
        -t guard:with-disclosure .
"""

from __future__ import annotations

import os
import sys

MODEL_ID = os.environ.get(
    "GUARD_DISCLOSURE_MODEL",
    "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2",
)
# Must match settings.disclosure_model_dir (app/config.py).
OUT_DIR = os.environ.get("GUARD_DISCLOSURE_MODEL_DIR", "/opt/disclosure-encoder")


def main() -> int:
    if not MODEL_ID:
        print("[export_disclosure_encoder] no model id — skipping (default image)")
        return 0

    from transformers import AutoModel, AutoTokenizer

    os.makedirs(OUT_DIR, exist_ok=True)
    print(f"[export_disclosure_encoder] Loading {MODEL_ID} …", flush=True)
    tokenizer = AutoTokenizer.from_pretrained(MODEL_ID)
    model = AutoModel.from_pretrained(MODEL_ID)

    print(f"[export_disclosure_encoder] Saving to {OUT_DIR} …", flush=True)
    tokenizer.save_pretrained(OUT_DIR)
    model.save_pretrained(OUT_DIR)

    # Fail the build loudly rather than ship an image whose operator asked for
    # the classifier and silently got the "no opinion" default back.
    weights = [f for f in os.listdir(OUT_DIR) if f.endswith((".safetensors", ".bin"))]
    if not weights:
        print(
            f"[export_disclosure_encoder] ERROR: no weights written to {OUT_DIR}",
            file=sys.stderr,
        )
        return 1

    print(f"[export_disclosure_encoder] Done ✓ ({', '.join(sorted(weights))})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

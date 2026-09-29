"""
Build-time ONNX export for GLiNER PII detection.

Runs inside the Docker build. Downloads the fp32 PyTorch weights once,
saves a local copy of the model + tokenizer, and exports a NON-quantized
(fp32) ONNX graph alongside it. The service loads that graph at runtime:
ONNX-runtime CPU speed (~30ms/call) with full fp32 recall.

BFSF-269: we deliberately do NOT INT8-quantize. The quantized graph was
~2x smaller/faster but collapsed person-name confidence (~0.88-0.98 →
~0.14-0.22), so bare names fell under the detection floor and only
regex-titled names were tokenised. fp32 ONNX keeps recall AND speed.

The graph is produced by whichever gliner requirements.txt pins, so a gliner
bump is also a new graph under the same filename (compare onnx_sha256 in the
eval metrics). The engine fingerprint carries the gliner version for that.
"""

from __future__ import annotations

import os
import sys

from gliner import GLiNER

MODEL_ID = os.environ.get("GUARD_PII_MODEL", "E3-JSI/gliner-multi-pii-domains-v1")
OUT_DIR = os.environ.get("GUARD_PII_ONNX_DIR", "/opt/gliner-onnx")

# Must match settings.pii_onnx_file (app/config.py). fp32 graph, not INT8.
ONNX_FILE = os.environ.get("GUARD_PII_ONNX_FILE", "model.onnx")


def main() -> int:
    os.makedirs(OUT_DIR, exist_ok=True)
    print(f"[export_onnx] Loading {MODEL_ID} …", flush=True)
    model = GLiNER.from_pretrained(MODEL_ID)

    print(f"[export_onnx] Saving model + tokenizer to {OUT_DIR} …", flush=True)
    model.save_pretrained(OUT_DIR)

    print("[export_onnx] Exporting fp32 ONNX graph (no quantization) …", flush=True)
    model.export_to_onnx(
        save_dir=OUT_DIR,
        onnx_filename=ONNX_FILE,
        quantize=False,
        opset=19,
    )

    # Fail the build loudly if the graph wasn't produced. Otherwise the
    # image ships with an empty ONNX dir and the service falls back to the
    # fp32 PyTorch weights (correct but ~30x slower) or a runtime HF
    # download — which egress-blocked pods can't reach (BFSF-269).
    onnx_path = os.path.join(OUT_DIR, ONNX_FILE)
    if not os.path.isfile(onnx_path) or os.path.getsize(onnx_path) == 0:
        print(
            f"[export_onnx] FATAL: expected ONNX graph at {onnx_path} "
            "was not produced — failing the build.",
            file=sys.stderr,
            flush=True,
        )
        return 1

    print(
        f"[export_onnx] Done ✓ ({onnx_path}, "
        f"{os.path.getsize(onnx_path) // (1024 * 1024)} MB)",
        flush=True,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())

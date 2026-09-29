"""INT8 dynamic quantization with attention-node exclusion — REJECTED, kept as record.

VERDICT (2026-07-31, full record in eval/MODEL-DECISIONS.md): attempt 1
excluded 120/153 MatMuls and still collapsed recall across the board (Person
1.0 -> 0.16, control group -> 0.0; measured on a mount-mangled run — the
REJECT rests on the graph-intrinsic size argument below, which needs no
re-run). The 33 quantized nodes were the 24 encoder
FFN matmuls plus the NINE GLiNER scoring heads (span_rep / prompt_rep /
projection) — the layers whose dot product IS the entity score; those must
stay fp32. But the deeper reason this line is closed: the 1.1GB graph is
~two-thirds multilingual embedding table (251k vocab, ~740MB fp32), which
MatMul-only dynamic quantization cannot touch — the ceiling is ~190MB saved
(measured: 1103 -> 913MB), far under the >=0.8GB adoption threshold. The RSS
prize requires embedding quantization (QAT territory) or a smaller-vocab
model, i.e. the model-swap track, not requantization of this graph. This
upgrades BFSF-269 from "INT8 is bad" to a mechanism with numbers.

Original experiment description follows.

INT8 dynamic quantization with attention-node exclusion — an EXPERIMENT.

BFSF-269 rejected INT8 wholesale: the generically-quantized graph was ~2x
smaller but collapsed person-name confidence (~0.88-0.98 → ~0.14-0.22), so
bare names fell under the detection floor. The published mechanism (see the
model-track research dossier) is narrower than "INT8 is bad": generic dynamic
INT8 quantizes DeBERTa's *attention* MatMuls, whose masked-fill interactions
break under INT8 calibration. Excluding attention/QKV nodes from quantization
preserved accuracy at a ~40% size cut in the documented ModernBERT case.

This script produces that middle graph from the already-baked fp32 export.
It is a BUILD TOOL for the experiment, not part of the runtime: the variant
is served by pointing GUARD_PII_ONNX_FILE at the output, and judged ONLY by
the eval gate with Person as the sentinel category:

    docker run --rm -v .../eval:/app/eval -e GUARD_PII_ONNX_FILE=model.int8-noattn.onnx \
        guard-eval:q python -m eval.run_eval --tier off --split dev --timing \
        --baseline eval/metrics.off.dev.fresh.json --tol 0.02 --gate-tier all \
        --out eval/metrics.off.dev.int8noattn.json

ADOPT only on: gate PASS (incl. HIGH_RISK rows, control group ±0.03, leak
metrics) AND a measured RSS saving ≥ 0.8GB. The prize is MEMORY headroom in
the 2.5Gi/4Gi pod, not speed (~8% published). At most two iterations of the
exclusion predicate below, then record the rejection with the metrics file.

Every graph variant gets its OWN filename: _engine_fingerprint hashes the
filename (not the graph bytes), so a distinct name is what busts the Redis
cache across a variant swap.
"""

from __future__ import annotations

import argparse
import os
import sys

# Substrings that mark a node as part of the attention path in the DeBERTa-v2/v3
# family (disentangled attention). Iterate HERE if Person recall drops:
# widen to embeddings/pooler on the first retry, then stop.
_ATTENTION_MARKERS = (
    "attention",
    "attn",
    "disentangled",
    "query",
    "key",
    "value",
    "pos_proj",
    "pos_q_proj",
    "pos_k_proj",  # disentangled position projections
)


def find_excluded_nodes(model_path: str) -> list[str]:
    import onnx

    model = onnx.load(model_path, load_external_data=False)
    excluded = [
        node.name
        for node in model.graph.node
        if node.op_type == "MatMul"
        and any(marker in node.name.lower() for marker in _ATTENTION_MARKERS)
    ]
    total_matmul = sum(1 for n in model.graph.node if n.op_type == "MatMul")
    print(
        f"[quantize_onnx] {total_matmul} MatMul nodes, excluding {len(excluded)} "
        f"attention-path nodes from quantization",
        flush=True,
    )
    if not excluded:
        print(
            "[quantize_onnx] WARNING: no attention MatMuls matched the markers — "
            "this would reproduce the generic INT8 recipe that BFSF-269 rejected. "
            "Inspect node names before proceeding.",
            file=sys.stderr,
            flush=True,
        )
    return excluded


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument(
        "--src",
        default=os.path.join(
            os.environ.get("GUARD_PII_ONNX_DIR", "/opt/gliner-onnx"), "model.onnx"
        ),
    )
    ap.add_argument(
        "--dst", default=None, help="default: <src dir>/model.int8-noattn.onnx"
    )
    ap.add_argument(
        "--list-only",
        action="store_true",
        help="print the exclusion list and exit without quantizing",
    )
    args = ap.parse_args()

    if not os.path.isfile(args.src):
        print(
            f"[quantize_onnx] FATAL: source graph {args.src} not found", file=sys.stderr
        )
        return 1
    dst = args.dst or os.path.join(os.path.dirname(args.src), "model.int8-noattn.onnx")

    excluded = find_excluded_nodes(args.src)
    if args.list_only:
        for name in excluded:
            print(f"  exclude: {name}")
        return 0

    from onnxruntime.quantization import QuantType, quantize_dynamic

    print(
        f"[quantize_onnx] Quantizing {args.src} → {dst} "
        f"(weights QInt8, MatMul-only, {len(excluded)} exclusions) …",
        flush=True,
    )
    quantize_dynamic(
        args.src,
        dst,
        weight_type=QuantType.QInt8,
        op_types_to_quantize=["MatMul"],
        nodes_to_exclude=excluded,
    )

    if not os.path.isfile(dst) or os.path.getsize(dst) == 0:
        print(f"[quantize_onnx] FATAL: {dst} was not produced", file=sys.stderr)
        return 1
    src_mb = os.path.getsize(args.src) // (1024 * 1024)
    dst_mb = os.path.getsize(dst) // (1024 * 1024)
    print(
        f"[quantize_onnx] Done ✓ {src_mb} MB → {dst_mb} MB "
        f"({100 - dst_mb * 100 // max(src_mb, 1)}% smaller). "
        f"Now run the eval gate — the size means nothing until Person recall holds.",
        flush=True,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())

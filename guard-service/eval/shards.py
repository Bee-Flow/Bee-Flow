"""Sharded eval: split one corpus run over N processes, merge the predictions.

The model eval is minutes of ONNX passes per record, so CI runs it as N shards
(``--shard i/N --preds-out F``) and one aggregate step (``--preds-in F...``)
that rebuilds the predictions in corpus order and runs the unchanged
evaluate + gate path. The merge exists to produce the report an unsharded run
would have produced, so everything that could make the shards describe
different measurements (arguments, backend, ONNX hash, versions, chunking) or
a different record set (gap, duplicate, extra) is a hard error here, never a
warning: a merged report that quietly scored 77 of 80 records is worse than a
red job.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from collections.abc import Callable, Sequence

from .matcher import SpanTuple
from .schema import Record
from .timing import merge_timing

FORMAT_VERSION = 1
# Salt for the shard bucket. Must differ from "" (the split) and "ci" (the
# subset): sharing a salt would make the shard a competing filter on the same
# axis and every shard of a subset would be empty or full (see load_corpus).
SHARD_SALT = "shard"
# Run metadata that legitimately differs per shard and is merged, not compared.
_PER_SHARD_META = ("timing_ms",)


class ShardError(Exception):
    """A shard file set that must not be merged."""


def parse_shard(spec: str) -> tuple[int, int]:
    """``'2/3'`` -> (2, 3). Raises ValueError unless 1 <= i <= N."""
    try:
        i_s, n_s = spec.split("/")
        i, n = int(i_s), int(n_s)
    except ValueError:
        raise ValueError(
            f"--shard must look like i/N (e.g. 2/3), got {spec!r}"
        ) from None
    if n < 1 or not 1 <= i <= n:
        raise ValueError(f"--shard {spec!r}: need N >= 1 and 1 <= i <= N")
    return i, n


def select_shard(records: Sequence[Record], i: int, n: int, bucket) -> list[Record]:
    """The records of shard ``i`` of ``n``; the shards are a disjoint exact cover."""
    return [r for r in records if bucket(r.id, salt=SHARD_SALT) % n == i - 1]


def build_doc(  # noqa: PLR0913
    measurement: dict,
    shard: str,
    run_meta: dict,
    records: Sequence[Record],
    preds: Sequence[Sequence[SpanTuple]],
    degraded: Sequence[bool],
) -> dict:
    return {
        "format": FORMAT_VERSION,
        "args": measurement,
        "shard": shard,
        "run_meta": run_meta,
        "records": [
            {
                "id": r.id,
                "preds": [[s.start, s.end, s.category, s.confidence] for s in p],
                "degraded": bool(d),
            }
            for r, p, d in zip(records, preds, degraded, strict=True)
        ],
    }


def write_doc(path: str, doc: dict) -> None:
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(doc, fh, ensure_ascii=False, sort_keys=True)


def load_doc(path: str) -> dict:
    try:
        with open(path, encoding="utf-8") as fh:
            doc = json.load(fh)
    except (OSError, ValueError) as exc:
        raise ShardError(f"{path}: cannot read predictions file: {exc}") from None
    if not isinstance(doc, dict) or doc.get("format") != FORMAT_VERSION:
        raise ShardError(f"{path}: not a format-{FORMAT_VERSION} predictions file")
    for key in ("args", "shard", "run_meta", "records"):
        if key not in doc:
            raise ShardError(f"{path}: missing {key!r}")
    return doc


def _diff(a: dict, b: dict) -> list[str]:
    return sorted(k for k in a.keys() | b.keys() if a.get(k) != b.get(k))


def _check_same(docs: Sequence[dict], names: Sequence[str]) -> None:
    first = docs[0]
    for doc, name in zip(docs[1:], names[1:], strict=True):
        bad = _diff(first["args"], doc["args"])
        if bad:
            raise ShardError(
                f"{name} disagrees with {names[0]} on measurement args: {', '.join(bad)}"
            )
        a = {k: v for k, v in first["run_meta"].items() if k not in _PER_SHARD_META}
        b = {k: v for k, v in doc["run_meta"].items() if k not in _PER_SHARD_META}
        bad = _diff(a, b)
        if bad:
            raise ShardError(
                f"{name} disagrees with {names[0]} on run_meta: {', '.join(bad)} "
                f"(shards must run on the same image, model and settings)"
            )


def _check_shard_set(docs: Sequence[dict]) -> None:
    specs = []
    for d in docs:
        try:
            specs.append(parse_shard(d["shard"]))
        except ValueError as exc:
            raise ShardError(str(exc)) from None
    totals = {n for _, n in specs}
    if len(totals) != 1:
        raise ShardError(f"shards disagree on N: {sorted(totals)}")
    (n,) = totals
    got = sorted(i for i, _ in specs)
    if got != list(range(1, n + 1)):
        raise ShardError(
            f"shard set is not exactly 1/{n}..{n}/{n}: got "
            + ", ".join(f"{i}/{n}" for i in got)
        )


def merge(
    docs: Sequence[dict],
    names: Sequence[str],
    expected: Sequence[Record],
    measurement: dict,
) -> tuple[list[list[SpanTuple]], list[bool], dict]:
    """Validate ``docs`` and rebuild (preds, degraded, run_meta).

    ``expected`` is load_corpus(split, subset) for the aggregate step's own
    arguments, and ``measurement`` those arguments: the shards must have been
    run with exactly them. The result is in corpus order, so downstream
    evaluation sees what an unsharded run would have.
    """
    if not docs:
        raise ShardError("no predictions files given")
    _check_same(docs, names)
    bad = _diff(docs[0]["args"], measurement)
    if bad:
        raise ShardError(
            f"the shards were run with different arguments than this step: {', '.join(bad)}"
        )
    _check_shard_set(docs)

    by_id: dict[str, tuple[list[SpanTuple], bool]] = {}
    for doc, name in zip(docs, names, strict=True):
        for rec in doc["records"]:
            if rec["id"] in by_id:
                raise ShardError(
                    f"record {rec['id']!r} appears twice (again in {name})"
                )
            by_id[rec["id"]] = (
                [
                    SpanTuple(int(s), int(e), str(c), float(f))
                    for s, e, c, f in rec["preds"]
                ],
                bool(rec["degraded"]),
            )
    want = [r.id for r in expected]
    missing = [i for i in want if i not in by_id]
    extra = sorted(by_id.keys() - set(want))
    if missing or extra:
        raise ShardError(
            f"record ids do not match the corpus: {len(missing)} missing"
            + (f" (e.g. {missing[:3]})" if missing else "")
            + f", {len(extra)} extra"
            + (f" (e.g. {extra[:3]})" if extra else "")
        )
    preds = [by_id[i][0] for i in want]
    degraded = [by_id[i][1] for i in want]
    run_meta = {
        k: v for k, v in docs[0]["run_meta"].items() if k not in _PER_SHARD_META
    }
    timing = merge_timing([d["run_meta"].get("timing_ms") or {} for d in docs])
    if timing:
        run_meta["timing_ms"] = timing
    return preds, degraded, run_meta


def add_shard_args(ap: argparse.ArgumentParser) -> None:
    ap.add_argument(
        "--shard",
        metavar="i/N",
        help="score only shard i of N of the split/subset (needs --preds-out)",
    )
    ap.add_argument(
        "--preds-out",
        metavar="FILE",
        help="write this run's predictions as JSON and exit: no evaluate, "
        "gate or --out. Merge the shards with --preds-in.",
    )
    ap.add_argument(
        "--preds-in",
        nargs="+",
        metavar="FILE",
        help="skip prediction: merge the --preds-out files of ALL shards "
        "(run with the same arguments) and evaluate/gate as one run",
    )


def pick_shard(
    args: argparse.Namespace, records: list[Record], bucket: Callable[..., int]
) -> tuple[str, list[Record]]:
    """Validate the shard flags; return (spec, this run's records)."""
    err = shard_arg_error(args)
    if err:
        raise SystemExit(err)
    shard = args.shard or "1/1"
    if not args.preds_out:
        return shard, records
    i, n = parse_shard(shard)
    return shard, select_shard(records, i, n, bucket)


def merge_files(paths: Sequence[str], records: Sequence[Record], measurement: dict):
    """``merge`` over files; a refusal ends the run with a non-zero exit."""
    try:
        return merge([load_doc(f) for f in paths], paths, records, measurement)
    except ShardError as exc:
        raise SystemExit(f"refusing to merge shards: {exc}") from None


def shard_arg_error(args: argparse.Namespace) -> str | None:
    """Reject argument combinations that would measure or merge the wrong thing."""
    if args.preds_in:
        for flag, val in (
            ("--shard", args.shard),
            ("--preds-out", args.preds_out),
            ("--endpoint", args.endpoint),
            ("--regex-only", args.regex_only),
        ):
            if val:
                return f"--preds-in cannot be combined with {flag}"
    if args.shard and not args.preds_out:
        return "--shard needs --preds-out (a lone shard must not be evaluated or gated)"
    if args.preds_out and args.endpoint:
        return "--preds-out cannot be combined with --endpoint"
    if args.shard:
        try:
            parse_shard(args.shard)
        except ValueError as exc:
            return str(exc)
    return None


def _digest(obj) -> str | None:
    if obj is None:
        return None
    blob = json.dumps(obj, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(blob).hexdigest()


def measurement(args, tier: str, label_groups, thresholds) -> dict:
    """The arguments that define WHAT was measured; shards and merge must agree."""
    return {
        "split": args.split,
        "subset": args.subset,
        "tier": tier,
        "bsn": args.bsn,
        "threshold": args.threshold,
        "mode": args.mode,
        "iou": args.iou,
        "regions": args.regions or "*",
        "label_groups_sha256": _digest(label_groups),
        "thresholds_sha256": _digest(thresholds),
    }

"""Sharded eval (--shard / --preds-out / --preds-in): model-free tests.

The model tier is replaced by a deterministic fake predictor, the regex tier
runs for real, so nothing here loads a model.

    python -m unittest tests.test_eval_shards
"""

from __future__ import annotations

import contextlib
import io
import json
import os
import tempfile
import unittest
from unittest import mock

from eval import run_eval
from eval.matcher import SpanTuple
from eval.run_eval import _bucket, load_corpus
from eval.shards import (
    ShardError,
    build_doc,
    load_doc,
    merge,
    parse_shard,
    select_shard,
)

_BASE = ["--split", "calibrate", "--subset", "ci"]


def _read(path: str):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def _write(path: str, obj) -> None:
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(obj if isinstance(obj, str) else json.dumps(obj))


def _fake_in_process(records, threshold, **kwargs):
    """Deterministic stand-in for the model: spans derived from the record."""
    preds = [
        [SpanTuple(0, 1 + len(r.id) % 5, "EmailAddress", 0.1 * (len(r.text) % 9))]
        if len(r.text) % 3
        else []
        for r in records
    ]
    degraded = [len(r.id) % 7 == 0 for r in records]
    meta = {
        "tier": kwargs["tier"],
        "backend": "onnx-fp32",
        "onnx_sha256": "abc",
        "timing_ms": run_eval.timing_summary(
            [10.0 + len(r.id) for r in records], records
        ),
    }
    return preds, degraded, meta


def _run(argv: list[str], fake: bool = False) -> tuple[int | str | None, str, str]:
    """main() with argv; returns (exit code, stdout, stderr)."""
    out, err = io.StringIO(), io.StringIO()
    patches = [mock.patch("sys.argv", ["run_eval", *argv])]
    if fake:
        patches.append(
            mock.patch.object(run_eval, "predict_in_process", _fake_in_process)
        )
    with contextlib.ExitStack() as stack:
        for p in patches:
            stack.enter_context(p)
        stack.enter_context(contextlib.redirect_stdout(out))
        stack.enter_context(contextlib.redirect_stderr(err))
        try:
            code = run_eval.main()
        except SystemExit as exc:
            code = exc.code
    return code, out.getvalue(), err.getvalue()


class ShardSelectionTests(unittest.TestCase):
    def test_parse_shard(self):
        self.assertEqual(parse_shard("2/3"), (2, 3))
        self.assertEqual(parse_shard("1/1"), (1, 1))
        for bad in ("0/3", "4/3", "1/0", "x", "1/2/3", "a/b", "-1/3", ""):
            with self.assertRaises(ValueError, msg=bad):
                parse_shard(bad)

    def test_shards_are_a_disjoint_exact_cover(self):
        records = load_corpus("calibrate", "ci")
        self.assertGreater(len(records), 10)
        for n in (1, 2, 3, 5):
            shards = [select_shard(records, i, n, _bucket) for i in range(1, n + 1)]
            ids = [r.id for s in shards for r in s]
            self.assertEqual(sorted(ids), sorted(r.id for r in records))
            self.assertEqual(len(ids), len(set(ids)))
            if n == 3:
                self.assertTrue(all(shards), "every shard of 3 should hold records")


class CliValidationTests(unittest.TestCase):
    def test_bad_combinations_exit_non_zero(self):
        with tempfile.TemporaryDirectory() as d:
            f = os.path.join(d, "p.json")
            cases = [
                ["--shard", "4/3", "--preds-out", f],
                ["--shard", "1/3"],  # a lone shard must not be gated
                ["--preds-in", f, "--shard", "1/3", "--preds-out", f],
                ["--preds-in", f, "--preds-out", f],
                ["--preds-in", f, "--endpoint", "http://x"],
                ["--preds-in", f, "--regex-only"],
                ["--preds-out", f, "--endpoint", "http://x"],
            ]
            for argv in cases:
                code, _, err = _run([*_BASE, *argv])
                self.assertNotIn(code, (0, None), argv)
                self.assertTrue(err or isinstance(code, str), argv)


class ShardRoundTripTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.dir = self._tmp.name

    def path(self, name: str) -> str:
        return os.path.join(self.dir, name)

    def shard_files(self, extra: list[str], fake: bool, n: int = 3) -> list[str]:
        files = []
        for i in range(1, n + 1):
            f = self.path(f"s{i}.json")
            code, _, err = _run(
                [*_BASE, *extra, "--shard", f"{i}/{n}", "--preds-out", f], fake
            )
            self.assertEqual(code, 0, err)
            self.assertFalse(os.path.exists(self.path("metrics.json")))
            files.append(f)
        return files

    def assert_same_report(self, extra: list[str], fake: bool):
        a, b = self.path("a.json"), self.path("b.json")
        self.assertEqual(_run([*_BASE, *extra, "--out", a], fake)[0], 0)
        files = self.shard_files(extra, fake)
        code, _, err = _run([*_BASE, *extra, "--preds-in", *files, "--out", b])
        self.assertEqual(code, 0, err)
        ra, rb = _read(a), _read(b)
        ta, tb = ra["meta"].pop("timing_ms", None), rb["meta"].pop("timing_ms", None)
        self.assertEqual(ra, rb)
        return ta, tb

    def test_regex_tier_merge_equals_unsharded(self):
        self.assert_same_report(["--tier", "regex"], fake=False)

    def test_fake_model_merge_equals_unsharded(self):
        ta, tb = self.assert_same_report(["--tier", "off"], fake=True)
        self.assertEqual(tb["n"], ta["n"])
        self.assertEqual(tb["shards"], 3)

    def test_preds_in_needs_no_model(self):
        files = self.shard_files(["--tier", "off"], fake=True)
        # no fake and no model installed: prediction must not be attempted
        with mock.patch.object(
            run_eval, "predict_in_process", side_effect=AssertionError("predicted")
        ):
            code, _, err = _run(
                [
                    *_BASE,
                    "--tier",
                    "off",
                    "--preds-in",
                    *files,
                    "--out",
                    self.path("m.json"),
                ]
            )
        self.assertEqual(code, 0, err)

    def test_shard_file_is_lossless(self):
        (f, *_) = self.shard_files(["--tier", "off"], fake=True)
        doc = load_doc(f)
        self.assertEqual(doc["shard"], "1/3")
        self.assertEqual(doc["args"]["tier"], "off")
        self.assertEqual(doc["run_meta"]["onnx_sha256"], "abc")
        want = {
            r.id: r for r in select_shard(load_corpus("calibrate", "ci"), 1, 3, _bucket)
        }
        self.assertEqual({r["id"] for r in doc["records"]}, set(want))
        exp, _, _ = _fake_in_process(list(want.values()), 0.7, tier="off")
        got = {r["id"]: [SpanTuple(*s) for s in r["preds"]] for r in doc["records"]}
        self.assertEqual([got[i] for i in want], exp)

    def merge_args(self, files, extra=()):
        return _run(
            [
                *_BASE,
                "--tier",
                "off",
                *extra,
                "--preds-in",
                *files,
                "--out",
                self.path("m.json"),
            ]
        )

    def rewrite(self, f: str, fn):
        doc = _read(f)
        fn(doc)
        _write(f, doc)

    def assert_refused(self, files, needle: str, extra=()):
        code, _, err = self.merge_args(files, extra)
        self.assertNotIn(code, (0, None))
        self.assertIn(needle, str(code) + err)
        self.assertFalse(os.path.exists(self.path("m.json")))

    def test_refuses_a_gap(self):
        files = self.shard_files(["--tier", "off"], fake=True)
        self.rewrite(files[1], lambda d: d["records"].pop())
        self.assert_refused(files, "missing")

    def test_refuses_a_missing_shard(self):
        files = self.shard_files(["--tier", "off"], fake=True)
        self.assert_refused(files[:2], "not exactly 1/3..3/3")

    def test_refuses_a_repeated_shard_file(self):
        files = self.shard_files(["--tier", "off"], fake=True)
        self.assert_refused([files[0], files[1], files[1]], "not exactly")

    def test_refuses_a_duplicate_record(self):
        files = self.shard_files(["--tier", "off"], fake=True)
        dup = _read(files[0])["records"][0]
        self.rewrite(files[1], lambda d: d["records"].append(dup))
        self.assert_refused(files, "appears twice")

    def test_refuses_an_extra_record(self):
        files = self.shard_files(["--tier", "off"], fake=True)
        extra = {"id": "not-in-corpus", "preds": [], "degraded": False}
        self.rewrite(files[1], lambda d: d["records"].append(extra))
        self.assert_refused(files, "1 extra")

    def test_refuses_run_meta_mismatch(self):
        files = self.shard_files(["--tier", "off"], fake=True)
        self.rewrite(files[2], lambda d: d["run_meta"].update(onnx_sha256="other"))
        self.assert_refused(files, "onnx_sha256")

    def test_refuses_shard_arg_mismatch(self):
        files = self.shard_files(["--tier", "off"], fake=True)
        self.rewrite(files[2], lambda d: d["args"].update(threshold=0.5))
        self.assert_refused(files, "threshold")

    def test_refuses_shards_run_with_other_args_than_the_merge(self):
        files = self.shard_files(["--tier", "off"], fake=True)
        self.assert_refused(files, "different arguments", extra=["--threshold", "0.5"])

    def test_refuses_mixed_shard_totals(self):
        files = self.shard_files(["--tier", "off"], fake=True)
        self.rewrite(files[2], lambda d: d.update(shard="3/4"))
        self.assert_refused(files, "disagree on N")

    def test_refuses_unreadable_or_foreign_file(self):
        files = self.shard_files(["--tier", "off"], fake=True)
        _write(files[0], "{not json")
        self.assert_refused(files, "cannot read")
        _write(files[0], {"format": 99})
        self.assert_refused(files, "format-1")


class MergeUnitTests(unittest.TestCase):
    def test_no_docs(self):
        with self.assertRaises(ShardError):
            merge([], [], [], {})

    def test_build_doc_keeps_floats_exactly(self):
        recs = load_corpus("calibrate", "ci")[:1]
        span = SpanTuple(3, 9, "IBAN", 0.1 + 0.2)
        doc = build_doc({}, "1/1", {}, recs, [[span]], [False])
        back = json.loads(json.dumps(doc))
        self.assertEqual(SpanTuple(*back["records"][0]["preds"][0]), span)


if __name__ == "__main__":
    unittest.main()

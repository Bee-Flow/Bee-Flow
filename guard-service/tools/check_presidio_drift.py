"""Report which ported Presidio recognizers have changed upstream.

    python -m tools.check_presidio_drift            # human-readable
    python -m tools.check_presidio_drift --json     # machine-readable
    python -m tools.check_presidio_drift --strict   # exit 1 on any drift

We vendor Presidio's CONTENT rather than depending on the package (see the
_comment block in presidio_upstream.json for why). The cost of vendoring is that
upstream fixes do not arrive on their own — a corrected checksum or a tightened
pattern just sits there, and nobody finds out.

This makes that visible. It compares the blob SHA recorded at port time against
the current one via the GitHub contents API, so it needs no presidio install, no
spaCy, and no version pin — which is what lets it run in the model-free CI job.

DRIFT IS NOT A FAILURE. Several of these ports deliberately diverge from
upstream (the NHS spec is anchor-required, only one of three plate formats is
taken, anchor words carry Dutch as well as English). A changed SHA means "go
read the diff and decide", not "sync it". That is why the default exit code is
0 and --strict is opt-in.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request

_MANIFEST = os.path.join(os.path.dirname(__file__), "presidio_upstream.json")
_API = "https://api.github.com/repos/{repo}/contents/{path}"


def _current_sha(
    repo: str, path: str, token: str | None
) -> tuple[str | None, str | None]:
    """Return (sha, error). Never raises — an offline CI run must not fail here."""
    req = urllib.request.Request(
        _API.format(repo=repo, path=path),
        headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": "beeflow-guard-service",
            **({"Authorization": f"Bearer {token}"} if token else {}),
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return json.load(resp).get("sha"), None
    except urllib.error.HTTPError as exc:
        return None, f"HTTP {exc.code}"
    except Exception as exc:  # noqa: BLE001 - reporting only
        return None, type(exc).__name__


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--json", action="store_true", help="emit JSON instead of text")
    ap.add_argument(
        "--strict",
        action="store_true",
        help="exit 1 when anything drifted or could not be checked",
    )
    args = ap.parse_args(argv)

    with open(_MANIFEST, encoding="utf-8") as fh:
        manifest = json.load(fh)

    repo = manifest["repo"]
    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    rows = []
    for entry in manifest["ported"] + manifest.get("evaluated_and_rejected", []):
        sha, err = _current_sha(repo, entry["path"], token)
        rows.append(
            {
                "path": entry["path"],
                "into": entry.get("into", "(not ported)"),
                "recorded": entry["sha"],
                "current": sha,
                "status": "unreachable"
                if sha is None
                else ("unchanged" if sha == entry["sha"] else "DRIFTED"),
                "error": err,
            }
        )

    if args.json:
        print(json.dumps({"repo": repo, "results": rows}, indent=2))
    else:
        drifted = [r for r in rows if r["status"] == "DRIFTED"]
        unreachable = [r for r in rows if r["status"] == "unreachable"]
        for r in rows:
            name = r["path"].rsplit("/", 1)[-1]
            if r["status"] == "unchanged":
                print(f"  ok         {name}")
            elif r["status"] == "DRIFTED":
                print(f"  DRIFTED    {name}  -> {r['into']}")
                print(
                    f"             https://github.com/{repo}/commits/main/{r['path']}"
                )
            else:
                print(f"  unchecked  {name}  ({r['error']})")
        print()
        if drifted:
            print(
                f"{len(drifted)} recognizer(s) changed upstream. Read the diff and "
                f"decide — several of these ports diverge on purpose; see the "
                f"`notes` field in presidio_upstream.json before syncing."
            )
        elif not unreachable:
            print("No drift.")

    if args.strict and any(r["status"] != "unchanged" for r in rows):
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

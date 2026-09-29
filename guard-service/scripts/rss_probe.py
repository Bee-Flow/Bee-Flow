"""Load the configured graph, prime, and print steady RSS — experiment helper.

Used by the CQ (INT8-noattn) experiment to compare resident memory between
graph variants under the same loading path the service uses. Not a runtime
component.
"""

from __future__ import annotations

from app.config import settings
from app.services.pii import get_pii_service


def main() -> int:
    svc = get_pii_service()
    svc.load(settings.pii_model)
    if not svc.ready:
        raise SystemExit(f"model failed to load: {svc.load_error}")
    with open("/proc/self/status", encoding="utf-8") as fh:
        vmrss_kb = int(fh.read().split("VmRSS:")[1].split()[0])
    print(
        f"RSS {vmrss_kb / 1024:.0f} MiB  backend={svc.backend} "
        f"file={settings.pii_onnx_file}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

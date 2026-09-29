"""Make ``app`` mean THIS service's module while its tests collect and run,
and stand in for the model stack so app.py imports without a GPU.

Every sidecar names its package (here: its module) ``app``, so one pytest
run over several of them would otherwise import the first service's code
for all of them. The modules of every service are parked in one
process-wide stash and swapped into sys.modules by root.

torch, whisperx and huggingface_hub are stubbed only when they are not
installed: the tests never reach a model, but app.py imports all three.
"""

import importlib.util
import os
import sys
import types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_STASH = "_beeflow_service_app_modules"

_stash: dict[str, dict] = getattr(sys, _STASH, None) or {}
setattr(sys, _STASH, _stash)
_stash.setdefault(ROOT, {})


def _own_the_app_package() -> None:
    if ROOT in sys.path:
        sys.path.remove(ROOT)
    sys.path.insert(0, ROOT)
    for name in list(sys.modules):
        if name != "app" and not name.startswith("app."):
            continue
        origin = getattr(sys.modules[name], "__file__", None) or ""
        owner = next((r for r in _stash if origin.startswith(r + os.sep)), None)
        if owner is not None:
            _stash[owner][name] = sys.modules[name]
        if owner != ROOT:
            del sys.modules[name]
    sys.modules.update(_stash[ROOT])


def pytest_pycollect_makemodule(module_path, parent):
    _own_the_app_package()
    return None


def pytest_runtest_setup(item):
    _own_the_app_package()


def _stub(name: str, **attrs) -> types.ModuleType:
    module = types.ModuleType(name)
    module.__dict__.update(attrs)
    sys.modules[name] = module
    return module


if importlib.util.find_spec("torch") is None:
    torch = _stub("torch", device=lambda spec: spec)
    torch.cuda = types.SimpleNamespace(
        is_available=lambda: False, empty_cache=lambda: None
    )

if importlib.util.find_spec("whisperx") is None:
    _stub("whisperx")

if importlib.util.find_spec("huggingface_hub") is None:
    hub = _stub("huggingface_hub")
    downloads = _stub(
        "huggingface_hub.file_download", hf_hub_download=lambda *a, **k: None
    )
    hub.file_download = downloads
    hub.hf_hub_download = downloads.hf_hub_download
